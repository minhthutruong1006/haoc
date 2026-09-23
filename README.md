# HAOC 블로그 자동화 (하오커뮤니케이션)

티스토리(5043) · 블로그스팟(5044) · 홈페이지(5045) 작성기 + 허브(5047). 바탕화면 `HAOC.bat` 한 번으로 실행.

## 두 PC 공유 방식 (2026-09-23)

| 무엇 | 어디에 |
|---|---|
| 코드·프롬프트·설정 | 이 GitHub 저장소 (private) |
| 사용 기록: 질문(`_used_log.json`)·사진(`_used_images.json`)·순환(`_gen_rotation.json`, `_cycle_state.json`) | Supabase `overrides` 테이블 `auto_haoc_*` 키 — `shared/haoc-sync.js` |
| 로그인(티스토리·블로거·홈페이지 관리자·Claude) | PC마다 따로 (저장소에 올리지 않음) |
| 원고 파일 `E:\하커_*_원고` | PC마다 따로 (각 PC는 자기가 만든 원고를 게시) |

- 두 PC가 **다른 플랫폼**을 동시에 돌려도 됨. 질문·사진 중복은 Supabase 기록으로 막힘.
- 두 PC가 **같은 플랫폼**을 동시에 누르면, 나중에 누른 쪽은 `⛔ 다른 PC(...)가 작업 중` 로그를 남기고 건너뜀 (잠금 15분 자동 만료).
- 다른 PC가 **오늘 이미 만든 블로그/슬롯**은 건너뜀 (하루 1편 유지).
- 인터넷이 끊기면 로컬 파일로 계속 동작하고, 다시 연결되면 병합해 올림 (`shared/.pending/`).
- 공유를 끄려면 `shared/sync.config.json` 의 `"enabled": false` (예전처럼 로컬만).

## 새 PC 설치

1. Node.js · Chrome · Git · Claude Code 설치, 드라이브 **E:** 필요 (없으면 `subst E: C:\HAOC_E`)
2. `git clone https://github.com/minhthutruong1006/haoc E:\haoc`
3. `E:\haoc\설치.bat` → 정션(E:\haoc-* → E:\haoc\haoc-*)·원고 폴더·npm install·바탕화면 HAOC.bat
4. 기존 PC에서 복사: `haoc-blogger-auto\client_secret_json_hao.json`, 각 폴더 `crm-notify.config.json`
5. 로그인 bat 실행(티스토리 1·2·3, 블로거 1, 홈페이지 1) → `HAOC.bat`

## 코드 수정 후

- 수정한 PC: `git add -A && git commit -m "..." && git push`
- 다른 PC: `E:\haoc\업데이트.bat` (git pull → 작성기 재시작)

---

### Tóm tắt tiếng Việt

- Code để trên GitHub. Dữ liệu đã dùng (câu hỏi, ảnh, lượt blog) để trên Supabase, nên 2 máy chạy cùng lúc không bị trùng.
- 2 máy cùng bấm **một nền tảng** thì máy bấm sau sẽ bị bỏ qua, log ghi `⛔ 다른 PC… 작업 중`. **Khác nền tảng** thì chạy song song được.
- Blog nào máy kia đã tạo trong hôm nay thì máy này bỏ qua (vẫn giữ mỗi blog 1 bài/ngày).
- Bản thảo và đăng nhập là riêng từng máy. Máy nào tạo bản thảo thì máy đó đăng.
- Cài máy mới: clone repo vào `E:\haoc`, chạy `설치.bat`, chép file bí mật từ máy cũ, đăng nhập rồi chạy `HAOC.bat`.
- Cập nhật code: chạy `업데이트.bat`.
