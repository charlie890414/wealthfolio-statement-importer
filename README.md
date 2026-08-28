# Wealthfolio CSV 對帳單匯入

將富邦證券複委託、永豐證券、Charles Schwab 與基富通的 CSV 對帳單轉換為 Wealthfolio 活動，先預覽並驗證，再直接匯入或下載標準 CSV。

## 開發

```bash
pnpm install
pnpm type-check
pnpm test
pnpm build
pnpm dev:server
```

每次匯入只處理一個 CSV，並由使用者選擇目的帳戶。讀取後會先顯示活動預覽，使用者可逐筆勾選要匯入的活動，並在執行 Wealthfolio `checkImport` 前映射標的；只有通過驗證且未被判定為重複的活動才會匯入或下載。

Addon 不會保存原始檔、不會自動補入或轉出資金、不會自動建立帳戶或修改市場報價。去重會先使用 Wealthfolio 原生結果，再以帳戶、日期、活動類型、標的、幣別與經濟數值做補強比對，忽略備註與時間；若主機無法讀取既有活動，介面會明確提示只採用原生去重。
