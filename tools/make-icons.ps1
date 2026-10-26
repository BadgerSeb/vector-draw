# Draws the app icon (a pen nib over a Bézier curve with square anchors, in Badger orange and
# steel) and writes icons\icon-192.png, icons\icon-512.png and icons\maskable-512.png.
param([string]$Out = (Join-Path (Split-Path $PSScriptRoot) 'icons'))
Add-Type -AssemblyName System.Drawing

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function P([float]$x, [float]$y, [float]$s) { New-Object System.Drawing.PointF ($x * $s), ($y * $s) }

# Draws the 256-unit design into $g at scale $s, offset ($ox, $oy)
function Draw-Icon($g, [float]$s, [float]$ox, [float]$oy, [bool]$tile) {
    $g.TranslateTransform($ox, $oy)
    $steel = [System.Drawing.Color]::FromArgb(27, 29, 32)
    $orange = [System.Drawing.Color]::FromArgb(210, 88, 0)
    $light = [System.Drawing.Color]::FromArgb(236, 237, 239)
    if ($tile) {
        $bg = New-RoundRect (8 * $s) (8 * $s) (240 * $s) (240 * $s) (44 * $s)
        $g.FillPath((New-Object System.Drawing.SolidBrush $steel), $bg)
    }
    # the curve, its handles and anchors
    $curve = New-Object System.Drawing.Pen $light, (11 * $s)
    $curve.StartCap = 'Round'; $curve.EndCap = 'Round'
    $g.DrawBezier($curve, (P 38 196 $s), (P 70 60 $s), (P 150 230 $s), (P 216 92 $s))
    $thin = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, 156, 164)), (5 * $s)
    $g.DrawLine($thin, (P 38 196 $s), (P 70 60 $s))
    $g.DrawLine($thin, (P 216 92 $s), (P 150 230 $s))
    $white = New-Object System.Drawing.SolidBrush $light
    foreach ($h in @(@(70, 60), @(150, 230))) { $g.FillEllipse($white, ($h[0] - 11) * $s, ($h[1] - 11) * $s, 22 * $s, 22 * $s) }
    $ob = New-Object System.Drawing.SolidBrush $orange
    $edge = New-Object System.Drawing.Pen $light, (5 * $s)
    foreach ($a in @(@(38, 196), @(216, 92))) {
        $g.FillRectangle($ob, ($a[0] - 17) * $s, ($a[1] - 17) * $s, 34 * $s, 34 * $s)
        $g.DrawRectangle($edge, ($a[0] - 17) * $s, ($a[1] - 17) * $s, 34 * $s, 34 * $s)
    }
    # pen nib, tip on the curve's middle
    $nib = New-Object System.Drawing.Drawing2D.GraphicsPath
    $nib.AddPolygon([System.Drawing.PointF[]]@((P 128 142 $s), (P 166 66 $s), (P 152 30 $s), (P 104 30 $s), (P 90 66 $s)))
    $g.FillPath($ob, $nib)
    $g.DrawPath((New-Object System.Drawing.Pen $light, (5 * $s)), $nib)
    $slit = New-Object System.Drawing.Pen $light, (5 * $s)
    $g.DrawLine($slit, (P 128 140 $s), (P 128 84 $s))
    $g.FillEllipse($white, 118 * $s, 74 * $s, 20 * $s, 20 * $s)
    $g.ResetTransform()
}

function Save-Icon([int]$size, [string]$path, [bool]$maskable) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    if ($maskable) {
        # full-bleed dark steel square; the design sits inside the 80% safe zone
        $g.Clear([System.Drawing.Color]::FromArgb(27, 29, 32))
        $s = $size * 0.66 / 256
        Draw-Icon $g $s (($size - 256 * $s) / 2) (($size - 256 * $s) / 2) $false
    } else {
        Draw-Icon $g ($size / 256.0) 0 0 $true
    }
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

New-Item -ItemType Directory -Force $Out | Out-Null
Save-Icon 192 (Join-Path $Out 'icon-192.png') $false
Save-Icon 512 (Join-Path $Out 'icon-512.png') $false
Save-Icon 512 (Join-Path $Out 'maskable-512.png') $true
Write-Host "Wrote icons to $Out"
