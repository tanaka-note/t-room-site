$ErrorActionPreference = 'Stop'
dotnet run --project (Join-Path $PSScriptRoot 'tests/XDownloader.Tests/XDownloader.Tests.csproj') -c Release
if ($LASTEXITCODE -ne 0) { throw 'Core/integration tests failed.' }
dotnet run --project (Join-Path $PSScriptRoot 'tests/XDownloader.AuthTests/XDownloader.AuthTests.csproj') -c Release
if ($LASTEXITCODE -ne 0) { throw 'Windows credential protection tests failed.' }
dotnet run --project (Join-Path $PSScriptRoot 'tests/XDownloader.UiTests/XDownloader.UiTests.csproj') -c Release
if ($LASTEXITCODE -ne 0) { throw 'WPF smoke tests failed.' }
