' BurnMeter - start the background server with no window at all.
Option Explicit
Dim fso, sh, appDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "node """ & appDir & "\server.js""", 0, False
