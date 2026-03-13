#!/bin/bash
# Enable GitHub Discussions and create a welcome post.
# Requires: gh CLI authenticated (gh auth login)
#
# Usage: bash scripts/enable-discussions.sh

set -e

REPO="proticom/gnosys"

echo "Enabling Discussions on $REPO..."
gh repo edit "$REPO" --enable-discussions

echo ""
echo "Creating welcome discussion..."
gh discussion create \
  --repo "$REPO" \
  --category "General" \
  --title "Welcome to Gnosys! Questions, feedback, and ideas go here" \
  --body "$(cat <<'EOF'
## Welcome! 👋

This is the place to ask questions, share feedback, propose ideas, and discuss anything related to Gnosys.

**Some good first topics:**

- How are you using Gnosys? Share your use case!
- Feature requests — what would make Gnosys more useful for you?
- Integration stories — which MCP client are you using? (Cursor, Claude Desktop, Claude Code, etc.)
- Bulk import experiences — what datasets have you imported?
- Bug reports and edge cases

**Useful links:**

- [README](https://github.com/proticom/gnosys#readme) — full documentation
- [DEMO.md](https://github.com/proticom/gnosys/blob/main/DEMO.md) — real-world import walkthrough (USDA + NVD)
- [gnosys.ai](https://gnosys.ai) — official website
- [npm package](https://www.npmjs.com/package/gnosys)

Looking forward to hearing from you!
EOF
)"

echo ""
echo "Done! Discussions are live at: https://github.com/$REPO/discussions"
