#!/usr/bin/env bash
# Cut a release: date the Unreleased notes in CHANGELOG.md, commit, and tag.
#
#   scripts/cut-release.sh [version]
#
# version defaults to the next alpha after the latest v* tag (0.1.0-alpha.26).
# Nothing is pushed; the script prints the push command, which starts the
# release workflow. See docs/RELEASE.md.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

die() { echo "cut-release: $*" >&2; exit 1; }

latest=$(git tag --list 'v*' --sort=-v:refname | head -1)
if [[ $# -ge 1 ]]; then
    version=${1#v}
elif [[ $latest =~ ^v(.*-alpha\.)([0-9]+)$ ]]; then
    version="${BASH_REMATCH[1]}$((BASH_REMATCH[2] + 1))"
else
    die "can't work out the next version from '$latest'; pass one"
fi
tag="v$version"

[[ $(git branch --show-current) == master ]] || die "not on master"
[[ -z $(git status --porcelain) ]] || die "working tree isn't clean"
git fetch --quiet origin master --tags
[[ $(git rev-parse HEAD) == $(git rev-parse origin/master) ]] \
    || die "master isn't level with origin/master; pull or push first"
git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null && die "$tag already exists"

grep -qx '## Unreleased' CHANGELOG.md || die "CHANGELOG.md has no '## Unreleased' heading"

# Keep an empty Unreleased on top and date the notes under it.
today=$(date +%Y-%m-%d)
awk -v heading="## $version ($today)" '
    !done && $0 == "## Unreleased" { print; print ""; print heading; done = 1; next }
    { print }
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

# Same check the release workflow runs: fails if the notes are empty.
if ! python3 .github/scripts/release-notes.py "$version" >/dev/null 2>&1; then
    git checkout -- CHANGELOG.md
    die "no notes under Unreleased"
fi

if [[ $version =~ -alpha\.([0-9]+)$ ]]; then
    title="Cycletron alpha ${BASH_REMATCH[1]}"
else
    title="Cycletron $version"
fi

git commit --quiet -m "release: $version" CHANGELOG.md
git tag -a "$tag" -m "$title"

echo "Tagged $tag ($title). Notes:"
echo
python3 .github/scripts/release-notes.py "$version"
echo
echo "To release:  git push origin master $tag"
echo "To undo:     git tag -d $tag && git reset --hard HEAD~1"
