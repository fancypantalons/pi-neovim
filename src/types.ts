/**
 * Shared types for the pi-nvim extension.
 */

/**
 * A single entry in the pi://edits buffer, formatted for the Neovim Lua
 * module. `text` carries the display string ("path | tool | time"); the Lua
 * side splits it into columns.
 */
export interface EditsEntry {
  filename: string;
  lnum: number;
  col: number;
  text: string;
}
