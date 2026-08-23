' BurnMeter - open the dashboard.
' Starts the server hidden if it isn't running yet, then opens the app window.
' Run with wscript.exe so nothing flashes on screen.
Option Explicit
Dim fso, sh, appDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "node """ & appDir & "\server.js"" --open", 0, False
