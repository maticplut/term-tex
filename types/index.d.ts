// Goes up each time an equation finishes compiling, which redraws every
// reply that is waiting on one.
export type CompileVersion = number

declare module 'claude-code' {
  interface PluginState {
    'term-tex': { version: CompileVersion }
  }
}
