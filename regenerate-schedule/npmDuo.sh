echo "npmDuo: Running command in dev node_modules..."
npm $1 $2

# Swap
mv node_modules node_modules__stash_while_installing
mv node_modules__prod node_modules

echo "npmDuo: Running command in production node_modules..."
npm $1 --production $2

# Swap
mv node_modules node_modules__prod 
mv node_modules__stash_while_installing node_modules

echo "npmDuo Done"