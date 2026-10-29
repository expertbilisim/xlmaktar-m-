Set shell = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
klasor = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = klasor
electron = klasor & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electron) Then
  MsgBox "XML Aktarım kurulumu eksik. electron.exe bulunamadı.", 16, "XML Aktarım"
  WScript.Quit 1
End If
shell.Run """" & electron & """ """ & klasor & """", 1, False
