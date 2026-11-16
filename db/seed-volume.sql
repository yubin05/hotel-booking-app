-- 운영 규모 데이터: 고객사가 운영 중인 DB에 쌓여 있다고 가정한 양 (소규모 회사 수준)
-- 숙소 1,000 / 객실 5,000 / 회원 2만 / 지난 예약 10만 / 리뷰 5만. 운영 환경(legacy · AWS v2)에는 항상 넣고, 트래픽 · 성능 · 비용 판단의 기준으로 쓴다.
-- 개발 PC · CI 테스트는 seed.sql만 쓴다 (속도, 운영 데이터를 개발 환경에 두지 않는 관례). 시드(숙소 10개)만으로는 표 전체를 훑는 쿼리도 공짜처럼 빨라서 성능 숫자를 믿을 수 없다
-- 실행 (Git Bash, 저장소 루트, docker compose down -v && up 직후):
--   docker compose exec -T db mysql -uroot -plocal-root-pw --default-character-set=utf8mb4 hotel_booking < db/seed-volume.sql
-- 만든 행의 id는 모두 'vol-'로 시작한다. 두 번 넣으면 첫 INSERT에서 중복 키로 멈추므로 다시 넣으려면 down -v부터

SET NAMES utf8mb4;
SET SESSION cte_max_recursion_depth = 100001;
-- 사진: 숙소 · 객실마다 고유 주소(크기 제외, 화면이 /640.webp · /1200.webp를 붙임). 숙소 번호는 시드 10곳 다음부터(n + 10)
-- 파일은 hotel-booking-aws-v2의 scripts/photos가 같은 키로 S3에 올린다 (v2 ADR-055)
SET @img = 'https://img.hotel.vundle34.cloud/';

CREATE TEMPORARY TABLE vol_seq (n INT PRIMARY KEY);
INSERT INTO vol_seq (n)
  WITH RECURSIVE s (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 100000)
  SELECT n FROM s;

-- 지역 쏠림: 서울·제주·부산에 숙소가 몰려 있다 (n % 100이 lo~hi면 그 도시)
CREATE TEMPORARY TABLE vol_city (lo INT, hi INT, city VARCHAR(100), region VARCHAR(100));
INSERT INTO vol_city VALUES
  (0, 29, '서울', '서울/경기'), (30, 49, '제주', '제주'), (50, 64, '부산', '부산/경남'),
  (65, 71, '강릉', '강원'), (72, 76, '속초', '강원'), (77, 82, '경주', '대구/경북'),
  (83, 88, '여수', '광주/전라'), (89, 93, '전주', '광주/전라'), (94, 99, '인천', '서울/경기');

INSERT INTO hotels (id, host_id, name, description, category, address, city, region, amenities, images)
SELECT CONCAT('vol-h-', LPAD(s.n, 4, '0')), '11111111-0000-0000-0000-000000000002',
       CONCAT(c.city, ' ', ELT(1 + s.n % 10, '호텔', '호텔', '호텔', '모텔', '모텔', '펜션', '펜션', '게스트하우스', '리조트', '캠핑'), ' ', s.n),
       CONCAT(c.city, ' 여행에 편안한 숙소입니다.'),
       ELT(1 + s.n % 10, 'hotel', 'hotel', 'hotel', 'motel', 'motel', 'pension', 'pension', 'guesthouse', 'resort', 'camping'),
       CONCAT(c.city, ' 중앙로 ', s.n), c.city, c.region,
       ELT(1 + s.n % 4, '["와이파이","주차장"]', '["와이파이","주차장","조식포함"]',
           '["와이파이","수영장","피트니스센터","레스토랑"]', '["와이파이","바베큐","주차장"]'),
       JSON_ARRAY(CONCAT(@img, 'hotels/', LPAD(s.n + 10, 4, '0'), '/1'), CONCAT(@img, 'hotels/', LPAD(s.n + 10, 4, '0'), '/2'))
  FROM vol_seq s JOIN vol_city c ON s.n % 100 BETWEEN c.lo AND c.hi
 WHERE s.n <= 1000;

-- 숙소마다 객실 5개 (도미토리는 1인)
INSERT INTO rooms (id, hotel_id, name, description, type, capacity, price_per_night, discount_rate, images, amenities)
SELECT CONCAT('vol-h-', LPAD(s.n, 4, '0'), '-r', k.k), CONCAT('vol-h-', LPAD(s.n, 4, '0')),
       ELT(k.k, '스탠다드', '디럭스', '스위트', '패밀리', '도미토리'), '편안하게 쉴 수 있는 객실입니다.',
       ELT(k.k, 'standard', 'deluxe', 'suite', 'family', 'dormitory'), ELT(k.k, 2, 2, 4, 4, 1),
       50000 + ((s.n * 37 + k.k * 11) % 250) * 1000, (s.n % 4) * 5,
       JSON_ARRAY(CONCAT(@img, 'rooms/', LPAD(s.n + 10, 4, '0'), '/', k.k)), '[]'
  FROM vol_seq s JOIN (SELECT 1 k UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) k
 WHERE s.n <= 1000;

-- 로그인할 수 없는 회원 (비밀번호 해시가 '!'). 지난 예약·리뷰의 주인
INSERT INTO users (id, email, password_hash, name)
SELECT CONCAT('vol-u-', LPAD(n, 5, '0')), CONCAT('vol-', n, '@sample.local'), '!', CONCAT('회원', n)
  FROM vol_seq WHERE n <= 20000;

-- 지난 예약: 객실마다 20건을 18일 칸에 하나씩 (시작 0~6일 밀림, 1~3박) → 같은 객실끼리 겹치지 않는다.
-- 기존 시드처럼 끝난 예약은 completed이고 날짜 잠금 행(booking_nights)이 없다
INSERT INTO bookings (id, user_id, room_id, check_in_date, check_out_date, guests, total_price, status, idempotency_key, created_at)
SELECT CONCAT('vol-b-', LPAD(b.n, 6, '0')), CONCAT('vol-u-', LPAD(1 + b.n % 20000, 5, '0')), r.id,
       b.ci, b.ci + INTERVAL b.nights DAY, LEAST(2, r.capacity), r.price_per_night * b.nights,
       'completed', CONCAT('vol-', b.n), b.ci - INTERVAL 14 DAY
  FROM (SELECT n, CURDATE() - INTERVAL (400 - ((n - 1) DIV 5000) * 18 - n % 7) DAY AS ci, 1 + n % 3 AS nights,
               CONCAT('vol-h-', LPAD(1 + ((n - 1) % 5000) DIV 5, 4, '0'), '-r', 1 + (n - 1) % 5) AS room_id
          FROM vol_seq) b
  JOIN rooms r ON r.id = b.room_id;

-- 리뷰: 지난 예약의 절반. 별점은 4~5점이 많게
INSERT INTO reviews (id, booking_id, user_id, hotel_id, rating, title, content, created_at)
SELECT CONCAT('vol-v-', SUBSTRING(b.id, 7)), b.id, b.user_id, r.hotel_id,
       ELT(1 + CRC32(b.id) % 10, 5, 5, 5, 4, 4, 4, 4, 3, 2, 1), '숙박 후기', '깨끗하고 편안하게 잘 쉬었어요.',
       b.check_out_date + INTERVAL 1 DAY
  FROM bookings b JOIN rooms r ON r.id = b.room_id
 WHERE b.id LIKE 'vol-b-%' AND CAST(SUBSTRING(b.id, 7) AS UNSIGNED) % 2 = 0;

-- 평점·리뷰 수를 리뷰 기준으로 맞춘다 (seed.sql과 같은 계산, 정합성 검사 기준)
UPDATE hotels h
   SET review_count = (SELECT COUNT(*) FROM reviews rv WHERE rv.hotel_id = h.id),
       rating       = COALESCE((SELECT ROUND(AVG(rv.rating), 1) FROM reviews rv WHERE rv.hotel_id = h.id), 0)
 WHERE h.id LIKE 'vol-h-%';

-- 확인: 숙소 1000 / 객실 5000 / 회원 20000 / 예약 100000 / 리뷰 50000 (시드 몫이 조금 더 있다)
SELECT 'hotels' AS 표, COUNT(*) AS 행 FROM hotels WHERE id LIKE 'vol-%'
UNION ALL SELECT 'rooms', COUNT(*) FROM rooms WHERE id LIKE 'vol-%'
UNION ALL SELECT 'users', COUNT(*) FROM users WHERE id LIKE 'vol-%'
UNION ALL SELECT 'bookings', COUNT(*) FROM bookings WHERE id LIKE 'vol-%'
UNION ALL SELECT 'reviews', COUNT(*) FROM reviews WHERE id LIKE 'vol-%';
