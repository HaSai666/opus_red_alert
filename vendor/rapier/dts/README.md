# Rapier 类型定义(参考用)

这些 `.d.ts` 从 npm 包 `@dimforge/rapier3d-compat@0.14.0` 抓取,仅作 API 参考。

保留原因:`castShape` / `castRayAndGetNormal` 这类方法的参数顺序极易搞错,
而参数错位不会报错,只会静默失效(本项目的角色穿地 bug 就是这么来的)。
排查时直接查阅这里的签名比翻压缩后的源码可靠得多。

`rapier.es.js` 本身不参与构建,这些文件也不参与运行,只是文档。
