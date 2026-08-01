# Metrics

`product_events` の許可済みイベントを、匿名セッションと日付で集計します。

- `visited`: 製品を開いた
- `gathering_created`: 受付を作成した
- `response_added`: 初回の返事を送った
- `response_updated`: 返事を変更または取り消した
- `waitlist_joined`: キャンセル待ちになった
- `waitlist_promoted`: 空席に繰り上がった
- `roster_exported`: 主催者が名簿を保存した
- `calendar_saved`: 参加者がカレンダー予定を保存した
- `public_gathering_viewed`: 受付ページを閲覧した
- `returned`: 再訪した

`x-atsumari-qa: 1` のイベントは保存時に `is_qa = 1` とし、実利用集計から除外します。イベントと回答は終了14日後、集計用の匿名イベントは45日後に定期削除します。
