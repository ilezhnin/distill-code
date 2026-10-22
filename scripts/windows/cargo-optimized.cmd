@echo off
rem The cargo of an optimized app launch (Launch-Flock.ps1 -Optimized): the
rem app's own crates at opt-level 2 on this command line only, so no shell,
rem agent or test the app starts inherits the setting.
cargo --config profile.dev.opt-level=2 %*
