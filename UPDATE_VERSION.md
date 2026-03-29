npm version patch

npm login

cd packages/sdk
npm version patch
npm run build
npm publish --access public

# Build toàn bộ chức năng

npm run build --workspaces

npm version patch

# 1. core

cd packages/core
npm publish --access public --otp=XXXX

# 2. adapters

cd ../adapter-b2
npm publish --access public --otp=XXXX

cd ../adapter-s3
npm publish --access public --otp=XXXX

# 3. downloader

cd ../downloader
npm publish --access public --otp=XXXX

# 4. sdk (cuối cùng)

cd ../sdk
npm publish --access public --otp=XXXX
