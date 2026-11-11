import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'
import { inlineToUnicode, split } from './parse'

// Draws Claude's replies in the terminal with display math ($$...$$, \[...\],
// equation/align/gather/multline) as images, through kitty's graphics
// protocol. The local latex and dvipng typeset each formula into a PNG,
// cached in ~/.cache/term-tex/. Inline math becomes Unicode where it can.

// Goes up as compiles finish; replies waiting on a formula read it, so a
// write redraws them.
const version = atom({ plugin: 'term-tex', key: 'version' } as const, 0)

// Cell size in screen pixels. It changes when kitty zooms, so it is read
// from the terminal (see CELL_PROBE); this is used until then, or if that fails.
type Cell = { width: number; height: number }
const FALLBACK_CELL: Cell = { width: 8, height: 16 }
// At size 1, one terminal row is one line of 10 pt TeX (12 pt baseline).
// TeX draws straight at the screen's pixel size, so kitty shows the picture
// 1:1. Shrinking a bigger picture left it soft, and kitty's own shrinking
// leaves jagged edges.
const dpiFor = (cell: Cell, size: number) => Math.round(((cell.height * 72.27) / 12) * size)

// Finds the terminal Claude runs in (the first parent process with a tty on
// stdin, stdout or stderr) and prints its cell size in pixels, from the
// window size the terminal reports to the tty. Reads nothing from the tty.
const CELL_PROBE = `
import os, fcntl, termios, struct
p = os.getpid()
while p > 1:
    for n in (0, 1, 2):
        try:
            t = os.readlink(f'/proc/{p}/fd/{n}')
        except OSError:
            continue
        if not t.startswith(('/dev/pts/', '/dev/tty')):
            continue
        try:
            fd = os.open(t, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
            r, c, x, y = struct.unpack('4H', fcntl.ioctl(fd, termios.TIOCGWINSZ, bytes(8)))
            os.close(fd)
        except OSError:
            continue
        if r and c and x and y:
            print(x // c, y // r)
            raise SystemExit
    p = int(open(f'/proc/{p}/stat').read().rsplit(')', 1)[1].split()[1])
`

// TeX and dvipng run in a bubblewrap sandbox: no network, no home folder,
// system folders read-only, and only the build folder writable. Since TeX
// Live 2026 openin_any does nothing, so TeX alone would \input any file.
// -no-shell-escape and openout_any=p stay as a second layer.
function sandboxed(bwrap: string, dir: string, argv: string[]): string[] {
  const binDir = argv[0]!.slice(0, argv[0]!.lastIndexOf('/'))
  return [
    bwrap, '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
    '--ro-bind-try', '/etc/texmf', '/etc/texmf',
    '--ro-bind-try', '/etc/fonts', '/etc/fonts',
    '--ro-bind-try', '/var/lib/texmf', '/var/lib/texmf',
    '--ro-bind-try', '/opt/texlive', '/opt/texlive',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', dir, '/work', '--chdir', '/work',
    '--setenv', 'HOME', '/work', '--setenv', 'PATH', `${binDir}:/usr/bin:/bin`, '--setenv', 'openout_any', 'p',
    '--', ...argv,
  ]
}
const MAX_RUNNING = 3

// `png` is the picture as base64. It goes to the terminal as bytes, not as a
// file name, as image.nvim does, so it also works inside tmux.
type Drawn = { file: string; png: string; columns: number; rows: number } | { error: string }
type Job = { key: string; body: string; dpi: number; cell: Cell }
type Tools = { latex: string; dvipng: string; magick: string; rm: string; bwrap: string; python: string | null; cacheDir: string }

const results = new Map<string, Drawn>()
const queued = new Set<string>()
const queue: Job[] = []
let tools: Tools | null = null
let running = 0
let finished = false
let cell: Cell = FALLBACK_CELL
// The terminal width the cell size was last read at. A zoom changes it.
let probedColumns = -1
let wantProbe = false
let probing = false
// Equations shown as TeX code after a press on [ show ], by message id and
// place in the message.
const showingCode = new Set<string>()
// Columns the buttons right of an equation take: `[ copy ]` and a gap.
const BUTTONS = 9

export const register: Register = (on, options) => {
  const color = /^#?[0-9a-fA-F]{6}$/.test(String(options.color)) ? String(options.color).replace('#', '').toUpperCase() : 'FFFFFF'
  const size = Number(options.size) > 0 && Number(options.size) <= 10 ? Number(options.size) : 1.33

  on('session.start', async ($, e, next) => {
    tools = await findTools($)
    if (!tools) $.ui.log('term-tex: latex, dvipng, magick or bwrap (bubblewrap) not found, so display math stays as TeX')
    else if (!tools.python) $.ui.log('term-tex: python3 not found, so equations are drawn for 8×16 px cells')
    wantProbe = true
    $.clock.every(100, () => pump($, color))
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const text = e.props.text
    if (!text.includes('$') && !text.includes('\\')) return next(e)

    const pieces = split(text)
    if (!tools || !pieces.some(p => p.kind === 'math')) {
      const converted = inlineToUnicode(text)
      return converted === text ? next(e) : next({ ...e, props: { ...e.props, text: converted } })
    }

    // A new terminal width may mean a new zoom: read the cell size again.
    const viewportColumns = e.viewport?.columns ?? 80
    if (viewportColumns !== probedColumns) {
      probedColumns = viewportColumns
      wantProbe = true
    }

    await read($, version)
    const { Box, Text, Markdown, Image, Button } = $.ui.resolve(e)
    // The [ copy ] and [ show ] buttons take BUTTONS columns on the right.
    const width = Math.max(10, viewportColumns - 2 - BUTTONS)
    const jobCell = cell
    const dpi = dpiFor(jobCell, size)

    const children = pieces.map((piece, i) => {
      if (piece.kind === 'text') {
        const t = inlineToUnicode(piece.text).trim()
        return t ? <Markdown key={`t${i}`} text={t} /> : null
      }
      const key = hash(`native ${color} ${dpi} ${jobCell.width}x${jobCell.height} ${piece.body}`)
      const drawn = results.get(key)
      if (!drawn && !queued.has(key)) {
        queued.add(key)
        queue.push({ key, body: piece.body, dpi, cell: jobCell })
      }
      const id = `${e.requestId}:${i}`
      const copy = (
        <Button key={`copy:${id}`} label="copy" onPress={press => void $.ui.copy({ text: piece.inner, surface: press.surface })} />
      )
      if (drawn && 'file' in drawn) {
        const asCode = showingCode.has(id)
        const toggle = (
          <Button
            key={`show:${id}`}
            label={asCode ? 'hide' : 'show'}
            onPress={() => {
              if (!showingCode.delete(id)) showingCode.add(id)
              finished = true
            }}
          />
        )
        const scale = Math.min(1, width / drawn.columns)
        const columns = Math.max(1, Math.floor(drawn.columns * scale))
        const rows = Math.max(1, Math.round(drawn.rows * scale))
        return (
          <Box key={`m${i}`} flexDirection="row" gap={1}>
            <Box width={width} flexShrink={0}>
              {asCode ? (
                <Markdown text={'```tex\n' + piece.tex + '\n```'} />
              ) : (
                <Image source={{ png: drawn.png }} columns={columns} rows={rows} alt={piece.tex} />
              )}
            </Box>
            <Box flexDirection="column" flexShrink={0}>
              {copy}
              {toggle}
            </Box>
          </Box>
        )
      }
      return (
        <Box key={`m${i}`} flexDirection="row" gap={1}>
          <Box width={width} flexShrink={0} flexDirection="column">
            <Markdown text={'```tex\n' + piece.tex + '\n```'} />
            {drawn && 'error' in drawn ? <Text dimColor>latex: {drawn.error}</Text> : null}
          </Box>
          <Box flexShrink={0}>{copy}</Box>
        </Box>
      )
    })

    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} gap={1}>
          {children}
        </Box>
      </Box>
    )
  })
}

// Reads the cell size when asked, starts queued compiles, and redraws the
// waiting replies once some finish or the cell size changed.
function pump($: Engine, color: string): void {
  if (wantProbe && !probing && tools?.python) {
    wantProbe = false
    probing = true
    void probeCell($, tools.python)
      .then(found => {
        if (found && (found.width !== cell.width || found.height !== cell.height)) {
          cell = found
          finished = true
        }
      })
      .catch(() => undefined)
      .finally(() => {
        probing = false
      })
  }
  if (finished) {
    finished = false
    void update($, version, n => n + 1).catch(() => undefined)
  }
  while (tools && running < MAX_RUNNING && queue.length > 0) {
    const job = queue.shift()!
    const t = tools
    running += 1
    void compile($, t, job, color)
      .catch(error => ({ error: String(error) }))
      .then(drawn => {
        results.set(job.key, drawn)
        queued.delete(job.key)
        running -= 1
        finished = true
      })
  }
}

async function compile($: Engine, t: Tools, job: Job, color: string): Promise<Drawn> {
  const png = `${t.cacheDir}/${job.key}.png`
  const meta = `${t.cacheDir}/${job.key}.json`
  if ((await $.fs.exists(meta)) && (await $.fs.exists(png))) {
    const { columns, rows } = JSON.parse(await $.fs.read(meta)) as { columns: number; rows: number }
    return { file: png, png: (await $.fs.read(png, { as: 'bytes' })).base64, columns, rows }
  }

  const dir = `${t.cacheDir}/build-${job.key}`
  const run = (argv: string[]) => $.process.run(argv, { cwd: dir, timeoutMs: 20_000 })
  const boxed = (argv: string[]) => run(sandboxed(t.bwrap, dir, argv))
  try {
    await $.fs.write(`${dir}/eq.tex`, document(job.body, color))
    const latex = await boxed([t.latex, '-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', 'eq.tex'])
    if (latex.exitCode !== 0) return { error: /^! (.*)$/m.exec(latex.stdout)?.[1] ?? 'compile failed' }
    const dvipng = await boxed([t.dvipng,'-q', '-D', String(job.dpi), '-T', 'tight', '-bg', 'Transparent', '-o', 'eq.png', 'eq.dvi'])
    if (dvipng.exitCode !== 0) return { error: `dvipng: ${dvipng.stderr.trim() || 'failed'}` }

    // Pad the picture to whole cells, so kitty's box keeps its shape.
    const size = await run([t.magick, 'identify', '-format', '%w %h', 'eq.png'])
    const [w = 0, h = 0] = size.stdout.trim().split(' ').map(Number)
    if (!w || !h) return { error: 'could not read the picture size' }
    const columns = Math.min(255, Math.ceil(w / job.cell.width))
    const rows = Math.min(255, Math.ceil(h / job.cell.height))
    const extent = `${columns * job.cell.width}x${rows * job.cell.height}`
    // The lines are thinner than a pixel, so the faint pixels are made more
    // solid, to look as bright as the terminal's text.
    const pad = await run([t.magick, 'eq.png', '-background', 'none', '-gravity', 'center', '-extent', extent, '-channel', 'A', '-evaluate', 'pow', '0.5', '+channel', `PNG32:${png}`])
    if (pad.exitCode !== 0) return { error: `magick: ${pad.stderr.trim() || 'failed'}` }
    await $.fs.write(meta, JSON.stringify({ columns, rows }))
    return { file: png, png: (await $.fs.read(png, { as: 'bytes' })).base64, columns, rows }
  } finally {
    await $.process.run([t.rm, '-rf', dir]).catch(() => undefined)
  }
}

function document(body: string, color: string): string {
  return [
    '\\documentclass[10pt]{article}',
    '\\usepackage[paperwidth=20cm,paperheight=60cm,textwidth=16cm]{geometry}',
    '\\usepackage{amsmath,amssymb,bm,xcolor}',
    '\\pagestyle{empty}',
    '\\begin{document}',
    `\\color[HTML]{${color}}`,
    body,
    '\\end{document}',
    '',
  ].join('\n')
}

async function findTools($: Engine): Promise<Tools | null> {
  const home = await $.env.get('HOME')
  // Absolute folders only: a relative one (such as `.`) would run a `latex`
  // that sits in the open project.
  const dirs = ((await $.env.get('PATH')) ?? '/usr/bin').split(':').filter(d => d.startsWith('/'))
  const find = async (name: string) => {
    for (const dir of dirs) if (await $.fs.exists(`${dir}/${name}`).catch(() => false)) return `${dir}/${name}`
    return null
  }
  const [latex, dvipng, magick, rm, bwrap, python] = await Promise.all(['latex', 'dvipng', 'magick', 'rm', 'bwrap', 'python3'].map(find))
  if (!home || !latex || !dvipng || !magick || !rm || !bwrap) return null
  return { latex, dvipng, magick, rm, bwrap, python: python ?? null, cacheDir: `${home}/.cache/term-tex` }
}

// The terminal's cell size in pixels, or null where it does not say
// (no tty found, or a terminal that reports no pixel size).
async function probeCell($: Engine, python: string): Promise<Cell | null> {
  const out = await $.process.run([python, '-I', '-c', CELL_PROBE], { timeoutMs: 5_000 })
  if (out.exitCode !== 0) return null
  const [width = 0, height = 0] = out.stdout.trim().split(/\s+/).map(Number)
  if (!(width >= 3 && width <= 200 && height >= 6 && height <= 400)) return null
  return { width, height }
}

// cyrb53: a short, stable file name for a formula.
function hash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}
