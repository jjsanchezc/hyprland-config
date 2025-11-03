require "nvchad.options"
-- Transparent background
-- vim.cmd [[
--   hi Normal guibg=NONE ctermbg=NONE
--   hi NonText guibg=NONE ctermbg=NONE
--   hi BufferLineBufferSelected guibg=NONE ctermbg=NONE
-- ]]
local opt = vim.opt

-- Relative line 
opt.relativenumber = true
opt.autoindent = true
opt.wrap = false 

-- Search settings

opt.ignorecase = true -- ignore case when searching
opt.smartcase = true -- if theres mixed case included i'll assume it's case sensitive

opt.cursorline = true

-- backspace
opt.backspace = "indent,eol,start"
