--- Telescope extension for pi-nvim — agent-modified file picker.
--- Registered automatically when pi-nvim's lua/ directory is on the
--- runtimepath (or when package.path is extended during RPC injection).

return require("telescope").register_extension({
  exports = {
    edits = function()
      require("pi-nvim").telescope_edits()
    end,
    pi_nvim = function()
      require("pi-nvim").telescope_edits()
    end,
  },
})
