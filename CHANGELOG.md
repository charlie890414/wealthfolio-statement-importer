## 1.1.1

- CSV 無法轉出活動時仍顯示逐列錯誤，避免只顯示「CSV 沒有可匯入的活動」。
- 加入完整 34 筆中信 ESPP 範例驗證，包含 2026 年 10 月及尾端空白列。
- 頁面顯示版本，方便確認已載入更新的套件。

# Changelog

All notable changes to the wealthfolioAddon addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial addon structure and setup

### Changed

### Deprecated

### Removed

### Fixed
- Derive Schwab reinvestment unit prices from settled amount and quantity to prevent fractional-cent cash drift.
- Exclude matched TDA-to-Schwab migration legs and reusable Taiwan warrant symbols from imports.

### Security

## [1.1.0] - 2026-09-09

### Changed
- Require Wealthfolio 3.8.0 and SDK/UI/dev-tools 3.8.
- Preserve broker final settlement amounts and execution prices; Wealthfolio 3.8 derives cash only when amount is missing.
- Update economic duplicate matching for migrated final amounts while retaining compatibility for missing-amount and rounding-drift rows.

## [1.0.0] - {{currentDate}}

### Added
- Initial release of wealthfolioAddon addon
- Basic addon functionality and core features
- Integration with Wealthfolio addon SDK v3.8.0
- Sidebar navigation integration for easy access
- Responsive design for all screen sizes

### Features
- A Wealthfolio addon for wealthfolioAddon
- User-friendly interface
- Compatible with Wealthfolio platform

### Compatibility
- Requires Wealthfolio 3.8.0 or newer
