# Persistent Windows bridge for Floating Island (PowerShell 5.1). Writes JSON lines to stdout:
#   {"type":"media", ...}               track, status or controls changed, or the position jumped (a seek)
#   {"type":"art", "key", "art"}        once per track, artwork as a data URL
#   {"type":"volume", "level", "muted"} system output volume changed
#   {"type":"messages", "unread", "items"}  WhatsApp notifications in Action Center (only WhatsApp's;
#                                       other apps' notifications are never read out) or its unread count changed
# Commands on stdin: toggle | play | pause | next | prev | seek <seconds> | volume <0..1> | mute | unmute
# Exits when stdin closes (the island quit).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, [Type]$type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    [void]$task.Wait(5000)
    $task.Result
}

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
    [Console]::Out.Flush()
}

# ---------------- volume (Core Audio, default output device) ----------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace FloatingIsland {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr p);
    int UnregisterControlChangeNotify(IntPtr p);
    int GetChannelCount(out uint c);
    int SetMasterVolumeLevel(float level, IntPtr ctx);
    int SetMasterVolumeLevelScalar(float level, IntPtr ctx);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint n, float level, IntPtr ctx);
    int SetChannelVolumeLevelScalar(uint n, float level, IntPtr ctx);
    int GetChannelVolumeLevel(uint n, out float level);
    int GetChannelVolumeLevelScalar(uint n, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int mask, out IntPtr devices); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

  public static class Volume {
    // Looked up on every call, so plugging in headphones switches devices without a restart.
    static IAudioEndpointVolume Endpoint() {
      var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice d;
      Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d)); // render, multimedia
      var iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }
    public static float Level() { float l; Endpoint().GetMasterVolumeLevelScalar(out l); return l; }
    public static bool Muted() { bool m; Endpoint().GetMute(out m); return m; }
    public static void SetLevel(float l) {
      var ep = Endpoint();
      ep.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, l)), IntPtr.Zero);
      if (l > 0) ep.SetMute(false, IntPtr.Zero);
    }
    public static void SetMute(bool m) { Endpoint().SetMute(m, IntPtr.Zero); }
  }
}
'@

# ---------------- media (System Media Transport Controls) ----------------
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$SessionManager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$MediaProps = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$StreamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]

# PowerShell can't bind WinRT interface members on the stream's COM wrapper, so go through reflection.
$AsStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
$ContentTypeProp = [Windows.Storage.Streams.IContentTypeProvider].GetProperty('ContentType')

function Read-Thumbnail($ref) {
    if (-not $ref) { return $null }
    try {
        $stream = Await ($ref.OpenReadAsync()) $StreamType
        $net = $AsStreamForRead.Invoke($null, @($stream))
        $ms = New-Object System.IO.MemoryStream
        $net.CopyTo($ms)
        $net.Dispose()
        $mime = "$($ContentTypeProp.GetValue($stream))"
        if (-not $mime) { $mime = 'image/png' }
        return "data:$mime;base64," + [Convert]::ToBase64String($ms.ToArray())
    } catch { return $null }
}

$manager = Await ($SessionManager::RequestAsync()) $SessionManager
$script:artKey = $null      # track whose artwork was last sent
$script:artTries = 0        # players often publish artwork a moment after the title
$script:lastSig = $null
$script:lastPos = 0.0
$script:lastStatus = ''
$script:lastEmit = [DateTimeOffset]::Now

function Poll-Media {
    $session = $manager.GetCurrentSession()
    $position = 0.0
    if (-not $session) {
        $state = [ordered]@{ type = 'media'; active = $false }
        $script:artKey = $null
    } else {
        $props = Await ($session.TryGetMediaPropertiesAsync()) $MediaProps
        $info = $session.GetPlaybackInfo()
        $tl = $session.GetTimelineProperties()
        $key = "$($session.SourceAppUserModelId)|$($props.Title)|$($props.Artist)"

        if ($key -ne $script:artKey) { $script:artKey = $key; $script:artTries = 0 }
        if ($script:artTries -ge 0) {
            $art = Read-Thumbnail $props.Thumbnail
            $script:artTries++
            if ($art -or $script:artTries -ge 6) {
                Emit @{ type = 'art'; key = $key; art = $art }
                $script:artTries = -1
            }
        }

        $status = "$($info.PlaybackStatus)"
        $position = $tl.Position.TotalSeconds
        # Players update the timeline sparsely; extrapolate while playing.
        if ($status -eq 'Playing' -and $tl.LastUpdatedTime.Year -gt 2000) {
            $position += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
        }
        $duration = ($tl.EndTime - $tl.StartTime).TotalSeconds
        if ($duration -gt 0) { $position = [Math]::Min($position, $duration) }
        $position = [Math]::Max($position, 0)
        $state = [ordered]@{
            type     = 'media'
            active   = $true
            key      = $key
            app      = "$($session.SourceAppUserModelId)"
            title    = "$($props.Title)"
            artist   = "$($props.Artist)"
            album    = "$($props.AlbumTitle)"
            status   = $status
            duration = [Math]::Round([Math]::Max($duration, 0), 1)
            canPrev  = [bool]$info.Controls.IsPreviousEnabled
            canNext  = [bool]$info.Controls.IsNextEnabled
            canSeek  = [bool]$info.Controls.IsPlaybackPositionEnabled
        }
    }

    # Send on any change, or when the position drifts from where the island will have extrapolated it.
    $sig = $state | ConvertTo-Json -Compress
    $now = [DateTimeOffset]::Now
    $expected = $script:lastPos
    if ($script:lastStatus -eq 'Playing') { $expected += ($now - $script:lastEmit).TotalSeconds }
    if ($sig -ne $script:lastSig -or [Math]::Abs($position - $expected) -gt 1.5) {
        $state.position = [Math]::Round($position, 1)
        Emit $state
        $script:lastSig = $sig
        $script:lastPos = $position
        $script:lastStatus = "$($state.status)"
        $script:lastEmit = $now
    }
}

$script:lastVolume = $null
function Poll-Volume {
    $level = [Math]::Round([FloatingIsland.Volume]::Level(), 3)
    $muted = [FloatingIsland.Volume]::Muted()
    $sig = "$level|$muted"
    if ($sig -ne $script:lastVolume) {
        Emit ([ordered]@{ type = 'volume'; level = $level; muted = $muted })
        $script:lastVolume = $sig
    }
}

# ---------------- WhatsApp (Action Center notifications + window title) ----------------
[void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
$Listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$NotificationList = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
$script:canReadNotifications = "$($Listener.GetAccessStatus())" -eq 'Allowed'
$script:unread = 0
$script:lastMessages = $null

function Read-Unread {
    # WhatsApp puts the unread-chat count in its window title: "(3) WhatsApp".
    $procs = @([System.Diagnostics.Process]::GetProcessesByName('WhatsApp.Root')) + @([System.Diagnostics.Process]::GetProcessesByName('msedgewebview2'))
    foreach ($p in $procs) {
        if ($p.MainWindowTitle -match '^\((\d+)\)\s+WhatsApp') { return [int]$Matches[1] }
    }
    return 0
}

function Poll-Messages {
    $items = @()
    if ($script:canReadNotifications) {
        $list = Await ($Listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $NotificationList
        $items = @(foreach ($n in $list) {
            if ("$($n.AppInfo.DisplayInfo.DisplayName)" -notmatch 'WhatsApp') { continue }
            $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
            if (-not $binding) { continue }
            $texts = @($binding.GetTextElements() | ForEach-Object { "$($_.Text)" })
            [ordered]@{
                id    = "$($n.Id)"
                title = $texts[0]
                body  = (@($texts | Select-Object -Skip 1) -join "`n")
                time  = $n.CreationTime.ToUnixTimeMilliseconds()
            }
        })
        $items = @($items | Sort-Object { $_.time } -Descending | Select-Object -First 12)
    }
    $state = [ordered]@{ type = 'messages'; unread = $script:unread; readable = $script:canReadNotifications; items = $items }
    $sig = $state | ConvertTo-Json -Compress -Depth 5
    if ($sig -ne $script:lastMessages) {
        Emit $state
        $script:lastMessages = $sig
    }
}

# ---------------- loop ----------------
# Console.In.ReadLineAsync() is synchronous on .NET Framework, so read the raw stream instead.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$pending = $stdin.ReadLineAsync()
$clock = [Diagnostics.Stopwatch]::StartNew()
$due = @{ media = 0; volume = 0; messages = 0; unread = 0 }

function Safely([scriptblock]$work) {
    try { & $work } catch { Emit @{ type = 'error'; message = "$($_.Exception.Message)" } }
}

while ($true) {
    # Wakes as soon as a command arrives, so a dragged volume slider isn't held to the poll rate.
    [void]$pending.Wait(100)
    while ($pending.IsCompleted) {
        $line = $pending.Result
        if ($null -eq $line) { exit 0 }
        $parts = $line.Trim() -split '\s+', 2
        Safely {
            switch ($parts[0]) {
                'volume' { [FloatingIsland.Volume]::SetLevel([float]::Parse($parts[1], [Globalization.CultureInfo]::InvariantCulture)); Poll-Volume }
                'mute'   { [FloatingIsland.Volume]::SetMute($true); Poll-Volume }
                'unmute' { [FloatingIsland.Volume]::SetMute($false); Poll-Volume }
                default {
                    $session = $manager.GetCurrentSession()
                    if ($session) {
                        switch ($parts[0]) {
                            'toggle' { [void](Await ($session.TryTogglePlayPauseAsync()) ([bool])) }
                            'play'   { [void](Await ($session.TryPlayAsync()) ([bool])) }
                            'pause'  { [void](Await ($session.TryPauseAsync()) ([bool])) }
                            'next'   { [void](Await ($session.TrySkipNextAsync()) ([bool])) }
                            'prev'   { [void](Await ($session.TrySkipPreviousAsync()) ([bool])) }
                            'seek'   {
                                # The position is in 100-nanosecond ticks.
                                $seconds = [double]::Parse($parts[1], [Globalization.CultureInfo]::InvariantCulture)
                                [void](Await ($session.TryChangePlaybackPositionAsync([long]($seconds * 10000000))) ([bool]))
                                $script:lastSig = $null   # report the new position on the next poll
                                $due.media = 0
                            }
                        }
                    }
                }
            }
        }
        $pending = $stdin.ReadLineAsync()
    }

    $now = $clock.ElapsedMilliseconds
    if ($now -ge $due.volume) { $due.volume = $now + 250; Safely { Poll-Volume } }
    if ($now -ge $due.media) { $due.media = $now + 600; Safely { Poll-Media } }
    if ($now -ge $due.unread) { $due.unread = $now + 2000; Safely { $script:unread = Read-Unread } }
    if ($now -ge $due.messages) { $due.messages = $now + 1000; Safely { Poll-Messages } }
}
