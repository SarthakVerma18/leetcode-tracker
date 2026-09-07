@echo off
REM Publish local progress to the GitHub Pages site.
REM Pulls first, then rebuilds, so the generated snapshot never conflicts.
title Publish LeetCode Tracker
cd /d "%~dp0"

echo Pulling latest...
git pull --rebase origin main || goto :fail

echo Rebuilding site...
python build_site.py || goto :fail

git add -A
git diff --staged --quiet && (echo Nothing to publish. & goto :done)

git commit -m "Publish progress update" || goto :fail
git push origin main || goto :fail
echo.
echo Published: https://sarthakverma18.github.io/leetcode-tracker/
goto :done

:fail
echo.
echo Publish failed - see the error above.

:done
pause
