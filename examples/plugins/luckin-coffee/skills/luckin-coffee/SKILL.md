---
name: luckin-coffee
description: Use when the user asks to order Luckin Coffee (瑞幸), search Luckin stores or products, check a pickup code or order status, or cancel a Luckin order - 瑞幸、luckin、咖啡、拿铁、美式、生椰拿铁、点单、下单、点一杯、门店、取餐码、订单状态、取消订单.
---

# 瑞幸咖啡点单（my-coffee）

本插件的 `my-coffee` MCP 服务直接连接瑞幸咖啡 AI 开放平台的远程端点。

## 使用前：访问凭据

凭据 `LUCKIN_MCP_TOKEN` 由用户在 https://open.lkcoffee.com/mcp 用手机号加短信验证码登录后创建或复制。
不要在对话里索取或接收凭据，也不要让用户把它写进文件。

- 工具或 `plugin_setup_get` 提示缺少凭据时，调用 `plugin_secret_request`（name 为 `LUCKIN_MCP_TOKEN`，reason 写明上面的获取方式）；Shoggoth 会在对话里弹出密码卡片。
- 提示凭据被拒绝（401/403）时，凭据可能已过期或被删除：请用户到上面的页面重新创建，再用同样方式更新。
- 无法弹出卡片时，请用户在插件页「快速设置」里填写。

## 工具

queryShopList、searchProductForMcp、switchProduct、queryProductDetailInfo、previewOrder、createOrder、queryOrderDetailInfo、cancelOrder。

首次调用某个工具前先读取它的 descriptor 与 schema，参数以 schema 为准。

## 执行约束

- 只支持到店自取。用户提到配送、外送、外卖、送到时，先说明只支持自提并征求同意。
- 下单顺序：确认门店、确认商品与数量、previewOrder、createOrder，不得跳步。
- `previewOrder` 返回的 `couponCodeList` 非空时，`createOrder` 必须原样透传。
- 支付信息只使用 `payOrderQrCodeUrl`，并给出可点击链接。
- 未完成支付前，不告知取餐码或预计取餐时间。
- 创建订单会产生真实订单与支付二维码：必须先得到用户对门店、商品、数量的明确确认，不要代替用户付款。
- 未提供准确经纬度时不展示门店距离。
