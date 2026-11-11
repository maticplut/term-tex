# term-tex

A Claude Code mod that shows the math in Claude's replies as typeset
equations in the [kitty](https://sw.kovidgoyal.net/kitty/) terminal.

- Display math (`$$...$$`, `\[...\]`, and the `equation`, `align`, `gather`
  and `multline` environments) is compiled with your local LaTeX and drawn as
  an image.
- Simple inline math, such as `$x^2 + y_i$`, becomes Unicode text (x² + yᵢ).
  Inline math with no simple Unicode form stays as TeX in a code span.
- Each equation has a `[ copy ]` button that copies its formula and a
  `[ show ]` button that shows its TeX code. See [Buttons](#buttons).
- Equations stay sharp when you zoom. The mod reads the terminal's cell size
  in pixels and draws each equation for it, so kitty shows the image pixel for
  pixel instead of scaling it.

## Requirements

- Linux.
- kitty, or another terminal with the kitty graphics protocol, such as Ghostty.
- `latex` and `dvipng`, for example from TeX Live.
- ImageMagick 7 (`magick`).
- [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`). Without
  it, the mod doesn't compile anything and display math stays as TeX.
- `python3`, to read the cell size. Without it, equations are drawn for 8×16
  pixel cells and don't adapt to zoom.

On Arch Linux:

```sh
sudo pacman -S texlive-bin texlive-basic texlive-latex texlive-latexrecommended imagemagick bubblewrap python
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install term-tex --marketplace maticplut/term-tex
```

From a shell:

```sh
claude plugin install term-tex --marketplace maticplut/term-tex
```

Answer `y` to add the marketplace, then pick a scope.

## Settings

Change these in the plugin's settings in Claude Code.

| Setting | Default | What it does |
| --- | --- | --- |
| `color` | `#ffffff` | Text color of the equations, as `#rrggbb`. Match it to kitty's foreground color. |
| `size` | `1.33` | How big equations are drawn. At `1`, one line of TeX is one terminal row. |

## Buttons

Each equation has two buttons on its right:

- `[ copy ]` copies the formula, without `$$`, `\[ \]` or
  `\begin{...}`/`\end{...}`.
- `[ show ]` shows the TeX code instead of the image. `[ hide ]` shows the
  image again.

Claude Code passes mouse clicks to the buttons only in its fullscreen mode.

## How it works

Each display formula goes into a small LaTeX document. `latex` compiles it
and `dvipng` turns it into a PNG at the resolution that matches the terminal's
cell height. ImageMagick pads the image to whole cells. The mod sends the
image to the terminal through the kitty graphics protocol.

Images are cached in `~/.cache/term-tex/`, one per formula, color, size
and cell size. Each zoom level compiles once.

## Security

Claude writes the formulas, and text that Claude reads, such as a web page or
a file, can influence what it writes. A formula is a TeX program, so the mod
runs `latex` and `dvipng` in a bubblewrap sandbox:

- No network access.
- No access to your home folder.
- System folders are read-only.
- Only the build folder for that formula is writable.

TeX also runs with `-no-shell-escape` and `openout_any=p`. TeX Live 2026
dropped the `openin_any` setting, so TeX alone can no longer keep a formula
from reading your files. The sandbox does that job instead.

## Limits

- The sandbox can't see TeX packages in `~/texmf`. Packages from your TeX
  installation work.
- Zellij doesn't show the images, so display math stays as TeX.
- Inside tmux, images show only with these lines in `~/.tmux.conf`:

  ```
  set -g allow-passthrough on
  set -g focus-events on
  ```

  The terminal size in pixels may also not reach the mod inside tmux.
  Equations are then drawn for 8×16 pixel cells.
- An equation wider than the window is shrunk by the terminal, so it looks
  softer.

## License

[MIT](LICENSE)
