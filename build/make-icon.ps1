Add-Type -AssemblyName System.Drawing

function New-RoundedPath([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Max(2, $r * 2)
  $path.AddArc($x, $y, $d, $d, 180, 90) | Out-Null
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90) | Out-Null
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90) | Out-Null
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90) | Out-Null
  $path.CloseFigure()
  return $path
}

function Save-XmlIcon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(1, [int]($size * 0.06))
  $radius = [Math]::Max(3, [int]($size * 0.22))
  $shape = New-RoundedPath $pad $pad ($size - 2 * $pad) ($size - 2 * $pad) $radius
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 29, 122, 171))
  $g.FillPath($brush, $shape)

  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $ustPx = [Math]::Max(5, [int]($size * 0.16))
  $altPx = [Math]::Max(8, [int]($size * 0.34))
  $ustFont = New-Object System.Drawing.Font "Segoe UI", $ustPx, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $altFont = New-Object System.Drawing.Font "Segoe UI", $altPx, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $ust = New-Object System.Drawing.RectangleF 0, ($size * 0.16), $size, ($size * 0.28)
  $alt = New-Object System.Drawing.RectangleF 0, ($size * 0.40), $size, ($size * 0.42)
  $g.DrawString("Expert", $ustFont, [System.Drawing.Brushes]::White, $ust, $format)
  $g.DrawString("XML", $altFont, [System.Drawing.Brushes]::White, $alt, $format)
  $ustFont.Dispose()
  $altFont.Dispose()

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  $shape.Dispose()
  $brush.Dispose()
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($size in 16, 24, 32, 48, 64, 128, 256) {
  Save-XmlIcon $size (Join-Path $dir "icon-$size.png")
}
Copy-Item (Join-Path $dir "icon-256.png") (Join-Path $dir "icon.png") -Force
