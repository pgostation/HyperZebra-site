This folder plays LUTIA 1.6 in a web browser (HyperZebra web player).

How to use it
- Put the whole folder on a web server and open index.html there.
  Opened from the disk (file://), it does not run: browsers do not run web workers and WebAssembly from files.
  To try it on your own computer: open a terminal in this folder, run  python3 -m http.server 8000
  and open http://localhost:8000/ in the browser.
- No server settings are needed: sw.js gives the page the isolation it needs (it reloads once the first time).
- Needs a recent browser with WebAssembly GC: Chrome or Edge 119, Firefox 120, Safari 18.2 or later.

What it does
- Clicks, typing (also Japanese input), the message box, the menus, answer and ask, wait, idle, visual effects,
  play (the stack's sounds and notes), beep, colour (AddColor), PICT pictures, shapes, paint layers,
  the other stacks this one goes to.
- Command-period (Ctrl-period) stops a running handler.
- Changes are kept in the browser, for this page, as HyperCard keeps a stack's changes: the stack opens again
  as it was left (a stack that can't be modified keeps only what its scripts save with "save stack").
  File > Save a Copy... downloads the stack with its changes. index.html?reset forgets them; a new export of
  the stack starts afresh; <html data-save="off"> in index.html keeps nothing.
- The stack's own 68K external commands (XCMD/XFCN) run as 68K code: the keys they read, what they draw on the
  card, their windows over the card.
- The stack's scripts were compiled into the player when it was exported (player-68k.wasm): the same
  results as the interpreter, faster. A script changed while it plays (set the script) runs interpreted.
- The stack reads keys as they are held (a game): on a touch screen (a phone, a tablet) the page shows a game pad
  under or beside the card, its keys those chosen at the export (data-gamepad in index.html lists them: up, down,
  left, right, space, return, shift, option, command, a letter...; change it to choose others). index.html?gamepad=1 shows
  it on any screen, ?gamepad=0 never; its small button hides it and shows it again.

Not yet
- Speech, the paint tools, shapes' SVG filters, PowerPC external commands.

Files
- index.html, player.js, worker.js, sw.js: the page and its scripts
- player.wasm: HyperZebra's HyperTalk core, built with TeaVM
- player-68k.wasm: the same with HyperZebra's 68K Macintosh emulation, for the stack's external commands
- wasm-gc-runtime.min.js: TeaVM's runtime (Apache License 2.0, see TeaVM-LICENSE.txt)
- LUTIA 1.6.hzb: the stack
