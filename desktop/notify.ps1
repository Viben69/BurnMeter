<#
  A Windows toast, from BurnMeter.

      -Title "Limit lifted"  -Body "Session limit reset. Go."  [-Sound]

  Uses the WinRT toast API directly so nothing has to be installed - no
  BurntToast, no modules. The AppId is an existing shortcut's, because
  Windows will not show a toast for an unregistered application; PowerShell's
  own is present on every machine that has PowerShell.

  Prints "ok" if the toast was handed to Windows, "skip <reason>" if this
  machine cannot show one. Never throws: a failed notification must not take
  the server down with it.
#>
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [switch]$Sound
)

$ErrorActionPreference = 'Stop'

try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
} catch {
  Write-Output "skip winrt-unavailable"
  exit 0
}

# The toast payload. Text is XML-escaped: a model name could contain an
# ampersand and a malformed document silently shows nothing.
$esc = {
  param($s)
  $s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;'
}
$audio = if ($Sound) { '<audio src="ms-winsoundevent:Notification.Reminder"/>' } else { '<audio silent="true"/>' }

$xml = @"
<toast activationType="protocol" launch="http://127.0.0.1:4317/">
  <visual>
    <binding template="ToastGeneric">
      <text>$(& $esc $Title)</text>
      <text>$(& $esc $Body)</text>
    </binding>
  </visual>
  $audio
</toast>
"@

try {
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  # Clears itself after a while rather than piling up in the Action Center.
  $toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(30)
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  Write-Output 'ok'
} catch {
  Write-Output "skip $($_.Exception.Message)"
}
