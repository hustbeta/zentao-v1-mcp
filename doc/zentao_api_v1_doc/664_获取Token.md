# 获取Token

- 原文：https://www.zentao.net/book/api/664.html

### 本篇目录

- [获取Token](#1)
- [请求URL](#2)
- [请求体](#3)
- [请求示例](#4)
- [请求响应](#5)
- [响应示例](#6)

POST

/tokens

## 获取Token

### 请求URL

https://xxx.com/api.php/v1/tokens

### 请求体

| 名称 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| account | string | 是 | 登录名 |
| password | string | 是 | 密码 |

### 请求示例

```
{"account": "admin", "password": "123456"}
```

### 请求响应

| 名称 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| token | string | 否 |  |

### 响应示例

```
{
    "token": "cuejkiesahl9k1j8be5bv5lndo"
}
```
