-- Cycletron transport bindings for Omarchy 4 (Quattro).
--
-- Paste into ~/.config/hypr/bindings.lua. Every verb below is forwarded to a
-- running Cycletron without raising its window, so these work while you are
-- looking at something else — which is the point of a transport hotkey.

o.bind("SUPER + ALT + SPACE", "Cycletron play/pause", "cycletron toggle")
o.bind("SUPER + ALT + H", "Cycletron hush", "cycletron hush")
o.bind("SUPER + ALT + UP", "Cycletron tempo +2", "cycletron tempo-nudge -- 2")
o.bind("SUPER + ALT + DOWN", "Cycletron tempo -2", "cycletron tempo-nudge -- -2")

-- Raise (or start) Cycletron itself.
o.bind("SUPER + ALT + C", "Cycletron", "cycletron")
