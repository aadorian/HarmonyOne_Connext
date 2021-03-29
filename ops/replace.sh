#!/bin/bash

old="$1"
new="$2"

if [[ -z "$old" || -z "$new" ]]
then echo "Exactly two args required: bash ops/replace.sh <replace_this> <with_this>" && exit 1
fi

# set sed flags so that they're valid on either linux or mac
if [[ "$(uname)" == "Darwin" ]]
then sedFlag=(-i '')
else sedFlag=(-i)
fi

echo "Before:"
bash ops/search.sh "$old"
echo
echo "After:"
bash ops/search.sh "$old" | sed "s|$old|$new|g" | grep --color=always "$new"
echo
echo "Does the above replacement look good? (y/n)"
echo -n "> "
read -r response
echo

if [[ "$response" == "y" ]]
then

  find \
    .github/workflows/* \
    Makefile \
    modules/*/migrations \
    modules/*/ops \
    modules/*/README.md \
    modules/*/src \
    modules/*/src.sol \
    modules/*/src.ts \
    modules/server-node/schema.prisma \
    ops \
    -type f -not -name "*.swp" -exec sed "${sedFlag[@]}" "s|$old|$new|g" {} \;

else echo "Goodbye"
fi
