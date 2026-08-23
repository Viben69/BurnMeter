' BurnMeter - login entry point.
' Starts the server hidden and pops the floating gauge. To start the server
' silently without any window, delete the --open-mini switch below.
Option Explicit
Dim fso, sh, appDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "node """ & appDir & "\server.js"" --open-mini", 0, False
