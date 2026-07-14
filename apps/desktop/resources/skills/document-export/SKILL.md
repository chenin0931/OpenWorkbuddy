---
name: document-export
description: 将 Markdown 报告稳定导出为 PDF 并登记到产物区；用户要求 PDF、文档导出、可打印报告或把 Markdown 转为 PDF 时使用。
metadata:
  openworkbuddy:
    version: 1.0.0
    permissions:
      - filesystem_read
      - filesystem_write
---

# 文档导出

使用 OpenWorkbuddy 内置渲染器生成可验证的 PDF，不通过 Shell 试探系统转换器。

## 工作流

1. 确认 Markdown 主文档已经落盘并完成回读验证。
2. 检查文档引用的本地图片是否位于当前授权范围。远程图片不会在导出时联网下载。
3. 调用 `capability_load({ toolIds: ["document_render"] })` 加载渲染工具。
4. 调用 `document_render({ inputPath, outputPath?, format: "pdf", title? })`。工具会执行路径校验、图片嵌入、PDF Header 和页数检查，并自动登记最终产物。
5. 使用返回的 `sha256`、`size`、`pages` 和产物引用作为完成证据。

## 约束

- 不为文档转换安装 Homebrew、Python 包或全局命令。
- 不依次尝试 LibreOffice、WeasyPrint、cupsfilter、FPDF、Playwright 等替代方案。
- 不把 HTML 中的脚本或远程内容带入渲染器。
- 渲染失败最多重试一次；仍失败时返回具体错误和 Markdown 原产物，不进行无边界探索。

## 完成标准

- PDF 具有有效 `%PDF-` Header、至少一页且不超过 50 MB。
- 更新已有 PDF 时已通过 hash 防止 stale write，并保存修改前快照。
- PDF 已作为 `final_output` 出现在产物区。
