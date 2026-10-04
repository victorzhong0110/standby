把用户导出的账本包（.json）放进这个目录，然后：

    npm run publish -- --inbox ./inbox

脚本会逐个校验签名与哈希链后才合并；分叉的包会被拒绝而不是被"挑一边"。
合并完执行 `npm run build` 重新部署。
