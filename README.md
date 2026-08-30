# Wealthfolio 對帳單匯入

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

Schwab 再投資交易會以 `abs(Amount) / abs(Quantity)` 推導有效單價，讓 Wealthfolio 以數量乘單價重建現金時精確符合結算金額；舊 TDA 股息描述中的括號代號會自動恢復。對帳基準中的 9 碼債券會略過本金買賣，只將可由同一份 CSV 計算出的到期折價收益轉成 `DEPOSIT`，以對齊既有帳戶的逐日現金結果。股息、稅款與選擇權也會使用跨 asset/subtype 別名的經濟去重。
