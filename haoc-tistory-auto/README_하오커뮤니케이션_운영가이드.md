# 하오커뮤니케이션(haoc.co.kr) 블로그 자동화 — 운영 가이드 (2026-09-14 구축)

하오디자인 자동화(C:\tistory-auto / blogger-auto / homepage-auto, 5023~5025)를 복제해 만든 **완전 별개의 프로그램**입니다.
폴더·포트·원고 폴더·사용 로그·크롬 프로필·토큰이 전부 따로라서 하디·하스·하팩과 동시에 돌려도 서로 섞이지 않습니다.
(공유하는 것은 ① Claude CLI 계정 저장소 C:\claude-accounts — 글 쓰는 AI 로그인, ② 사진 Drive 폴더 — 하오디자인(인쇄물)·하오스튜디오(촬영) 포트폴리오. 두 회사가 하오커뮤니케이션의 디자인센터·스튜디오센터라 같은 사진을 씁니다.)

| 플랫폼 | 프로그램 폴더 | 포트 | 원고 폴더 | 게시 방식 |
|---|---|---|---|---|
| 티스토리 3개 | E:\haoc-tistory-auto | 5043 | E:\하커_tistory_원고 (= E:\haoc_drafts) | 브라우저 자동화(카카오 로그인 1회) |
| 블로그스팟 3개 | E:\haoc-blogger-auto | 5044 | E:\하커_blogspot_원고 | Blogger API(구글 동의 1회 → token.json) |
| 홈페이지 칼럼 | E:\haoc-homepage-auto | 5045 | E:\하커_homepage_원고 | admin.html 칼럼 폼 자동 입력(관리자 로그인 1회) |
| 통합 허브 | E:\haoc-hub | 5047 | | 탭 3개 한 페이지 |
| 전체 시작 | 바탕화면 **HAOC.bat** (작성기 3개+허브 순차 기동 → http://127.0.0.1:5047) | | | |

## 질문 (5주제 × 100개)
- 원본: `E:\하커_tistory_원고\질문원본_하커_질문_500.csv` (Downloads\하커_질문_500\하커_질문_500_v5.csv 복사본, 열 = NO.,정부지원사업,디자인,웹,스튜디오,마케팅)
- UI [질문 시트 새로고침] = `fetch-questions.js` → 하오팩토리 통합시트와 같은 5블록×24열 구조의 `E:\하커_tistory_원고\질문목록.csv` 로 변환. 3개 프로그램이 이 CSV 하나를 공유.
- 구글시트로 옮기고 싶으면 `writer_config.json` → `questionSource.sheetCsvUrl` 에 시트 CSV 주소(export?format=csv&gid=…)를 넣으면 그걸 내려받는다(열 구조는 하오팩토리 통합시트와 동일: 질문|포스팅 체크|…, 포스팅 체크=TRUE면 건너뜀).
- 사용기록 키(usedNo) = 1 정부지원사업 · 2 디자인 · 3 웹 · 4 스튜디오 · 5 마케팅 — 3플랫폼이 같은 `_used_log.json`을 써서 같은 질문이 두 번 쓰이지 않는다. 발행된 질문은 매 생성 전 `sync-posted.js`가 RSS/피드/홈페이지 목록을 보고 영구 제외(postedRows)한다.

## 주제 ↔ 블로그 매핑 (2026-09-15 운영자 확정)
| 플랫폼 | 블로그/사이트 | 주제(질문 열) | 글 유형 | 빈도 |
|---|---|---|---|---|
| 티스토리 | haocommunication | 디자인 | 사진 1장 포트폴리오 | 하루 1편 — 3블로그를 날마다 번갈아(디자인→웹→마케팅) |
| 티스토리 | haocommunication02 | 마케팅 (2026-09-16 교정: 실제 블로그 주제) | 정보글(사진 없음, 마케팅 폴더에 사진 생기면 자동 사진 1장) | 〃 |
| 티스토리 | haocommunication03 | 웹(홈페이지 제작) (2026-09-16 교정) | 정보글(웹 폴더에 사진 생기면 자동 사진 1장) | 〃 |
| 블로그스팟 | haocommunication / 02 / 03 | 디자인 / 마케팅 / 웹 (2026-09-16 교정) | 티스토리와 동일 | 하루 1편, 날마다 번갈아 |
| 홈페이지 | haoc.co.kr (정부지원사업) | 정부지원사업 열을 디자인→웹→마케팅 성격으로 분류해 날마다 회전 | 디자인 차례=사진, 웹·마케팅 차례=정보글 | 하루 1편 |
| 홈페이지 | design.haoc.co.kr | 디자인 | 사진 1장(대표이미지) | 하루 1편 |
| 홈페이지 | studio.haoc.co.kr | 스튜디오 | 사진 1장 | 하루 1편 |
| 홈페이지 | web.haoc.co.kr | 웹 | 정보글 | 하루 1편 |
| 홈페이지 | mkt.haoc.co.kr | 마케팅 | 정보글 | 하루 1편 |

- 티스토리·블로그스팟 UI는 기본 1건 — [오늘 생성]을 누르면 오늘 차례 블로그 1개만 생성(같은 날 다시 눌러도 같은 블로그, 순환 기록 `_gen_rotation.json`). 3건을 고르면 3블로그 전부.
- 홈페이지 UI는 기본 5건(사이트 5개). 정부지원사업 사이트의 회전 상태는 `_cycle_state.json`(생성 성공 시 다음 주제로).
- 같은 '디자인' 열을 티스토리·블로그스팟·design 센터가 나눠 쓰지만 사용기록(usedNo 2)을 공유해 같은 질문이 두 번 쓰이지 않는다. 정부지원사업·스튜디오 열은 홈페이지에서만 쓴다.
- 매핑·글 유형은 각 `writer_config.json`(blogs[].blocks / sites·topics)만 고치면 바뀐다.

## 사진(Drive) — 하오디자인·하오스튜디오 폴더 공유
- 인쇄물: catalogue / brochure / 리플렛 / 팜플렛 / 패키지 / 포스터(하오디자인 폴더) · 촬영: 제품촬영 / 화장품촬영 / 건강식품촬영 / 식품촬영 / 상세페이지(하오스튜디오 폴더).
- 질문/제목의 산출물 단어(카탈로그·리플렛·패키지·포스터·촬영·상세페이지…)로 폴더를 좁히고, 업종 단어(화장품·식품·기계…)로 프로젝트 폴더를 앞세운다.
- 고른 사진은 Claude가 실제로 열어 '완성 결과물 사진(인쇄물 연출 컷/촬영 컷/상세페이지 완성본)'인지 판정(사전 눈검사) — 납작한 PDF 페이지·작업컷은 제외.
- 사용한 폴더·하위폴더는 `_used_log.json`에 기록돼 재사용되지 않는다(미사용이 바닥나면 가장 오래된 것부터). 사용내역.txt에 'used로 옮길 파일'이 적힌다.
- **정보글(웹·마케팅)에는 사진이 없다** — 원하면 해당 블록의 imageMode를 portfolio로 바꾸고 categories에 Drive 폴더를 넣으면 된다.

## 홈페이지 칼럼(5개 사이트) 형식
- 사이트 5개 모두 같은 관리자 구조(각 사이트 /admin.html → 칼럼 탭 폼: 제목/날짜/요약/본문/썸네일, 저장소는 같은 Supabase, 키만 hv_/hao_/hs_/hw_/hm_). 로그인 세션(hub_session 쿠키, .haoc.co.kr 공통)은 한 번 로그인하면 5개 사이트에 다 적용된다.
- 본문은 **순수 텍스트**(문단=빈 줄, 소제목=줄 앞 ■, FAQ=Q./A. 문단) — 프롬프트(스킬 haoc-column)와 동일. design 센터만 편집기(리치 텍스트)라 게시 스크립트가 문단을 <p>, ■ 소제목을 <h3>로 넣고 키워드 칸도 채운다.
- 원고 파일은 `.txt`(첫 줄 `#META {"headline","summary","keywords","site","topic","date","mode","thumb"}`), 파일명 `사이트_주제_질문.txt`. 미리보기는 UI에서.
- 포트폴리오 글은 Drive 사진 1장을 JPG로 만들어 대표이미지(썸네일)로 업로드하고, 본문에는 그 프로젝트를 글로 묘사한다. 정보글은 대표이미지 없음.
- 게시 = 각 사이트 admin.html 폼 자동 입력 → [저장]. 저장은 즉시 공개(공개/숨김 구분 없음). 이미 같은 제목이 있으면 건너뛴다. 발행 확인은 Supabase 칼럼 목록(읽기 전용)으로 한다.

## 최초 1회 준비 — 첫 [게시] 때 로그인 창이 자동으로 뜬다
- **티스토리**: 첫 게시 때 창이 열리면 카카오 로그인 1회 → auth.json 저장 → 이후 자동. (미리 하려면 `1_티스토리_로그인.bat`) 카테고리를 만들었으면 `2_티스토리_카테고리가져오기.bat`(없어도 발행됨 — 카테고리만 미지정). ★각 블로그 '주소 설정=문자'여야 영문 슬러그 URL이 적용된다.
- **블로거**: 첫 게시 때 구글 동의 화면이 열림 → haocommunication 블로그 소유 계정 선택+[허용] 1회 → token.json → blogId 자동 조회 → 이후 자동. (미리 하려면 `1_블로거_구글인증.bat`, client_secret은 하오팩토리와 같은 GCP 앱 재사용)
- **홈페이지**: 첫 게시 때 admin.html 창이 열림 → 아이디/비밀번호 로그인 1회(세션 12시간, 이 패키지 전용 chrome-profile). (미리 하려면 `1_홈페이지_관리자로그인.bat`)
- **Claude 계정**: C:\claude-accounts 공용(하디·하스·하팩과 같음). 작성기 UI의 'Claude 계정 연동' 박스에서 확인·추가.

## 매일 운영
1. 바탕화면 `HAOC.bat` → 허브(5047) 한 페이지, 탭 3개.
2. 각 탭에서 건수 선택 → [오늘 생성] → 원고·점수(SEO/AEO/GEO 20점, 18점 이상 기준) 검토(미리보기·제목 수정) → [게시].
3. 하루 1편 규칙: 게시 전 각 블로그 RSS/피드를 직접 확인해 오늘 이미 올라간 계정은 건너뜀. 전날 미게시 원고는 오늘 폴더로 이월된다(발행 안 된 것만).
4. 점수 누계 `E:\하커_tistory_원고\_seo_scores.csv`(3플랫폼 공용), 사용내역은 날짜 폴더의 사용내역.txt, 실행 로그는 각 폴더 job.log.

## 프롬프트(엔진) — 스킬 원문을 자동화용으로 옮긴 것
- 티스토리: `E:\haoc-tistory-auto\prompts\하오커뮤니케이션_티스토리_엔진.md` (스킬 haoc-tistory 2단계)
- 블로그스팟: `E:\haoc-blogger-auto\prompts\하오커뮤니케이션_블로그스팟_엔진.md` (스킬 haoc-blogger 2단계)
- 홈페이지: `E:\haoc-homepage-auto\prompts\하오커뮤니케이션_홈페이지_칼럼_엔진.md` (스킬 haoc-column 2단계)
- 각 파일 맨 아래 [자동화 변경 내역]에 수동판과 달라진 점을 적어 두었다. 프롬프트를 고치면 writer 재시작 불필요(다음 생성부터 반영). engine.js를 고치면 재시작 필요.

## 테스트 도구(E:\haoc-tistory-auto)
- `node _test_images.js [blogNo]` — Drive 폴더 탐색/선택만 점검(Claude 호출 없음)
- `node _test_generate.js <blogNo> "<질문>" [usedNo]` — 질문을 직접 주고 1편 생성(게시 안 함). usedNo(1~5)로 블록(주제·글 유형) 지정.
- `node sync-posted.js` — 발행 대조 미리보기(--apply로 반영)

## 2026-09-16 운영자 지시 반영
- **질문 출처 = 구글시트** `https://docs.google.com/spreadsheets/d/1Lv8v1O5rGeY9KNDZZnEm1PFxxfCRmrVvFGU1aWP-xbo/edit?gid=2011921129` (티스토리 writer_config `questionSource.sheetCsvUrl`). UI [질문 시트 새로고침] 또는 `node fetch-questions.js`로 내려받아 3플랫폼 공용 `질문목록.csv` 갱신. 시트 질문 순서가 기존 로컬 CSV와 같아 `_used_log.json` 행 번호 그대로 유효.
- **중복 규칙**: 발행 확인된 질문(postedRows, 시트 포스팅 체크 TRUE) 영구 제외 · 원고만 있고 미발행이면 3일 뒤 재사용 가능(기존 동작 유지).
- **목업 강제**(3엔진 `mockupOnlyCat`, writer_config `mockupOnlyCategories` = 디자인 인쇄물 6폴더): 파일명에 mockup/목업이 있는 사진만 후보. 목업 없는 폴더는 건너뛰고(비목업 폴백 없음), 눈검사까지 끝내 목업이 없으면 **저장하지 않고 '목업 사진 없음'으로 실패 처리**. 패키지 폴더(19개)는 목업 파일이 없어 사실상 제외 — 목업 파일을 넣으면 자동 포함. 촬영·웹·마케팅 폴더는 기존 눈검사만.
- **웹·마케팅 전용 사진 폴더** 등록(`imageCategoriesDrive.웹` = 1GrmPvzq8Mwq7dmhmvhCDqlKpSd_X3A-4, `.마케팅` = 12NQ-rQCSUr6uFx6oJ3GpUZRDV2O-DE0K). 블록 imageMode `portfolio-auto`: 생성 때마다 폴더를 읽어 사진이 있으면 사진 1장 포트폴리오, 비어 있으면 정보글. 사진을 넣으면 다음 생성부터 자동 전환(별도 조작 불필요). 프로젝트별 하위 폴더 권장, 루트에 바로 넣으면 2장 이상.
- **글 1편당 사진 1장**: imagesPerPost 1 (기존 그대로, 검증에서 강제).
- 백업: 각 폴더 `engine.js.bak_20260916`, `writer_config.json.bak_20260916`, `E:\하커_tistory_원고\질문목록.csv.bak_20260916`.
- ⚠ 미결: 실제 블로그 주제는 haocommunication02=마케팅, 03=홈페이지 제작(티스토리·블로그스팟 동일)인데 writer_config는 02=웹/03=마케팅 — 게시 전 확정 필요.

## 2026-09-16 CRM 연동부 통합 (Pictures\CRM\CRM분리\crm-addon → 하커 3종)
- 3개 폴더 `crm-notify.js`(공용, notifyCrm + trackKey + ctaTrackHtml) + `crm-notify.config.json`(brand haoc / prefix hc / platform / token / ctaTrack). **token 비면 완전 no-op**.
- 훅: 티스토리 watcher.js(발행 OK 직후 게시현황 전송, 발행 URL 포함 · 본문 조립 시 CTA 추적링크 치환) / 블로그스팟 writer.js(발행 직후 전송 · 본문 전송 전 CTA 치환) / 홈페이지 writer.js(게시 성공분 전송, 텍스트 본문이라 CTA 치환 없음).
- CTA 치환은 `ctaTrack=true` + token 둘 다 있을 때만 `href="https://haoc.co.kr/"` → CRM `/go/hc+md5(제목)16자`. 브랜드 haoc를 CRM에 등록한 뒤 켤 것(그 전엔 링크가 깨짐).
- 활성화: CRM에서 haoc 토큰 발급 → 3개 config token 입력 → blogger/homepage writer 재시작. 원본은 `*.bak_20260916_crm`. 안내·재적용 패치: `Pictures\CRM\CRM분리\4_haoc-automation\하커_적용_안내.txt`.

## 2026-09-16 하단 배너 + UTM (티스토리·블로그스팟, 발행 시점 적용)
- 모듈 `post-footer.js` + 설정 `post-footer.config.json`(티스토리·블로그스팟 폴더 각각). 원고 파일은 그대로 두고 **발행 직전**에 ① CTA 박스의 `https://haoc.co.kr/` 링크에 UTM 부착 ② 글 맨 아래 '공식 홈페이지 바로가기' 배너(UTM 링크) 추가.
- UTM: `utm_source=tistory|blogspot · utm_medium=blog · utm_campaign=계정명 · utm_content=cta_text|cta_banner · utm_term=hc추적키`. ⚠ haoc.co.kr에 GA/GTM이 **없음**(9/16 확인) → UTM은 홈페이지에 GA를 달아야 집계됨. 클릭 집계는 CRM ctaTrack(/go/ 추적링크)으로도 가능(켜면 CTA·배너 둘 다 /go/로 바뀜).
- 배너 이미지: 원본 `Pictures\하커\하오커뮤니케이션_홈페이지배너.png`(886×226) → `assets/banner_homepage.png`(두 폴더). 티스토리는 로컬 파일을 에디터에 업로드(kakaocdn URL, `assets/banner_hosted.json`에 저장). 블로그스팟은 호스팅 URL 필요: Drive **하단배너** 폴더(1oPGR2zuWieIdNUL9DJzqrXwbRLsKClPn, 하오디자인 루트 안, 현재 비어 있음)의 첫 이미지 lh3 URL → 없으면 티스토리가 저장한 URL → 둘 다 없으면 배너 없이 발행(로그 남김). **배너 PNG를 Drive 하단배너 폴더에 넣어 두면 가장 확실.**
- 끄기: post-footer.config.json `utm.enabled` / `banner.enabled` false. 티스토리는 다음 발행부터, 블로그스팟은 writer 재시작. 원본 `*.bak_20260916_footer`.

## 2026-09-18 CRM 연동 현황
- CRM(mail-crm-mvp.vigo.co.kr)은 콘텐츠 추적 설정이 브랜드 구분 없는 전역 1세트(피드 목록·수신 토큰·추적 목적지 dfirst.co.kr). 하커 블로그 6개+haoc 사이트는 피드에 등록돼 게시 현황에 자동 수집됨.
- 3개 폴더 `crm-notify.config.json`에 공용 수신 토큰 입력 → 발행 즉시 게시현황 전송(피드 수집분과 URL/제목으로 중복 병합, category 보강). **ctaTrack은 false 고정** — /go/ 링크가 무조건 dfirst.co.kr로 가므로 켜면 독자가 퍼스트디자인 사이트로 이동함.
- 클릭 집계는 CRM으로 불가. 대안: haoc.co.kr 관리자 HEAD 코드에 자체 카운터(Supabase 기록) 또는 GA4.

## 2026-09-18 운영자 지시 반영(질문·사진·썸네일)
- **질문**: 발행 확인된 질문만 영구 제외. 미발행은 ①오늘 고른 질문 ②원고 파일이 아직 남아 있는 질문만 막는다(3플랫폼 공유). 원고를 지우거나 `_삭제보관`으로 옮기면 그 질문은 다시 쓸 수 있다.
- **웹(홈페이지 제작) 주제는 '상세페이지' 질문 제외**(`excludeQuestionPatterns`). 정부지원사업 회전에서 상세페이지 질문은 디자인 차례로 분류. 디자인 블록의 패키지·단상자·라벨·포장 질문은 패키지 목업이 생길 때까지 임시 제외.
- **사진**: `_used_images.json`에 실제로 쓴 사진을 파일 단위로 기록 → 같은 사진 재사용 금지·중복 판정도 실제 쓴 사진만. 웹·마케팅(`fileLevelReuseCategories`)은 폴더가 아니라 사진 단위로 재사용을 막는다. 눈검사가 질문을 보고 '주제와 잘 맞는 순서'를 매겨 1순위를 쓴다(로그 "주제 맞춤 순위").
- **홈페이지 '또는 썸네일 경로/URL'**: 파일 선택 전에 먼저 `영문제목(소문자·공백없음).haoc.co.kr` 입력(원고 #META의 slug 사용).
- **다시 쓰기**: 오늘 폴더의 해당 원고를 `E:\하커_homepage_원고\_삭제보관\`으로 옮기고 [생성]. 옛 날짜 폴더의 미게시 원고는 자동 이월되므로 새로 쓰려면 그것도 옮긴다.

## 2026-09-19 운영자 지시 반영
- **질문 시트 자동 갱신**: [생성]을 누르면 3개 작성기 모두 먼저 구글시트에서 질문 목록을 다시 받아 온 뒤 글을 쓴다(실패하면 기존 목록으로 진행, 로그 "질문 시트: …"). 수동 [질문 시트 새로고침] 버튼도 그대로.
- **질문 중복 방지(3플랫폼 공통)**: 발행된 질문은 '질문 내용'으로도 기록(`postedMap`)해서 시트에서 질문을 바꿔 넣거나 자리를 옮겨도 발행된 질문은 다시 안 쓰고, 같은 행에 새로 넣은 질문은 정상적으로 쓴다. 미발행은 오늘 고른 질문·원고 파일이 남아 있는 질문만 막는다.
- **홈페이지 '또는 썸네일 경로/URL'**: ① 칸에 `영문제목(소문자·공백없음).haoc.co.kr`를 먼저 입력 → ② 그다음 이미지 넣기(같은 이름으로 스토리지에 올려 업로드 이미지 자리에 넣음). 저장 주소는 `…/images/영문제목.haoc.co.kr`. ⚠ 칸에 라벨만 저장하면(이미지 없이) 글 페이지 이미지가 깨진다(9/19 실험으로 확인) — 하지 말 것. 업로드 실패 시 예전처럼 파일 선택으로 진행.
