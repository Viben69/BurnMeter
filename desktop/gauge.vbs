' BurnMeter - open just the floating gauge.
' Starts the server hidden if it isn't running yet, then opens the gauge window.
Option Explicit
Dim fso, sh, appDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "node """ & appDir & "\server.js"" --open-mini", 0, False
