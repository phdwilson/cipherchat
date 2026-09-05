# CipherZip 桌面端

全中文现代扁平化 UI（React + Vite + Electron）。

## 开发

```bash
# 需先构建 core
npm run build -w @cipherzip/core
npm run dev -w @cipherzip/desktop   # Vite
# 另开终端
cd cipherzip/desktop && npx electron .
```

## 打包 Windows

```bash
npm run pack:win -w @cipherzip/desktop
# 产物：release/CipherZip-Portable-*.exe
```
