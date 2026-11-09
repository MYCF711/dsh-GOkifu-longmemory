#!/bin/bash
# T186：逐个甄别遗留分支（只读，不删）
for b in $(git branch -r | grep -v 'HEAD\|origin/main$' | sed 's#origin/##'); do
  ahead=$(git rev-list --count origin/main..origin/$b 2>/dev/null)
  dcount=$(git diff --numstat origin/main...origin/$b 2>/dev/null | wc -l)
  last=$(git log -1 --format=%cs origin/$b 2>/dev/null)
  if [ "$dcount" = "0" ]; then
    echo "$last|$b|内容已全在 main（ahead=$ahead，diff=0）|可删"
    continue
  fi
  mb=$(git merge-base origin/main origin/$b 2>/dev/null)
  files=$(git diff --numstat "$mb"...origin/$b 2>/dev/null | awk '{print $3}')
  touched=0; total=0
  for f in $files; do
    total=$((total+1))
    if [ -n "$(git log --oneline "$mb"..origin/main -- "$f" 2>/dev/null | head -1)" ]; then touched=$((touched+1)); fi
  done
  if [ "$total" -gt 0 ] && [ "$touched" -eq "$total" ]; then
    echo "$last|$b|主线在分叉后改过它全部 $total 个文件（已被取代）|可删（需人复核一句）"
  else
    echo "$last|$b|仍有 $((total-touched))/$total 个文件主线没再动过|值得看一眼"
  fi
done | sort -r
