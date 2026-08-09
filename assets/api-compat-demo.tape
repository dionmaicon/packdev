# PackDev API Compatibility demo — rendered with VHS (https://github.com/charmbracelet/vhs)
#
#   Regenerate:  npm run build && vhs assets/api-compat-demo.tape
#                (writes assets/api-compat-demo.gif)
#
# Project setup lives in assets/api-compat-demo-setup.js (which also launches
# a throwaway fake registry via assets/api-compat-demo-server.js) so this tape
# stays free of the escaped quotes / JSON that VHS's Type parser can't handle.

Output assets/api-compat-demo.gif

Set Shell "bash"
Set FontSize 20
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Dracula"
Set PlaybackSpeed 1.0

# --- Setup: scratch app + fake registry + `packdev` wrapper on PATH -----------
# Typed instantly and cleared so it does not appear in the recording.
Set TypingSpeed 0ms
Type "read D REG < <(node assets/api-compat-demo-setup.js $PWD); export PATH=$D/bin:$PATH; cd $D/app; clear" Enter
Sleep 500ms
Set TypingSpeed 60ms

# --- Demo ---------------------------------------------------------------------
Type "# Your app imports formatDate from acme-utils@1.0.0 - what does it export?" Enter
Sleep 800ms
Type "packdev api acme-utils" Enter
Sleep 3s

Type "# About to upgrade? Check every published version against what you actually use" Enter
Sleep 800ms
Type `packdev api-diff acme-utils --range ">=1.0.0 <3.0.0" --registry $REG` Enter
Sleep 4s

Type "# 2.0.0 silently dropped formatDate - packdev caught it before a broken upgrade" Enter
Sleep 3s
