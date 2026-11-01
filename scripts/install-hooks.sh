#!/bin/sh
# 安装本地 pre-push 钩子：禁止直推 main
mkdir -p .git/hooks
cat > .git/hooks/pre-push <<'HOOK'
#!/bin/sh
while read local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/main) echo "pre-push: 禁止直推 main；请走分支→PR→检查→合并" >&2; exit 1;;
  esac
done
exit 0
HOOK
chmod +x .git/hooks/pre-push
echo "installed .git/hooks/pre-push"
