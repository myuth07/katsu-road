/**
 * Katsu Road - Seed Data Generator
 * Generates 1,000+ realistic Tonkatsu restaurants distributed across major Korean cities.
 */

const SEED_DATA = (function() {
  const cities = [
    { name: "서울", latMin: 37.45, latMax: 37.65, lngMin: 126.80, lngMax: 127.15, districts: ["강남구", "서초구", "송파구", "마포구", "용산구", "종로구", "성동구", "영등포구", "서대문구", "강서구"] },
    { name: "부산", latMin: 35.05, latMax: 35.25, lngMin: 129.00, lngMax: 129.20, districts: ["해운대구", "수영구", "부산진구", "동래구", "남구", "연제구", "금정구", "사하구"] },
    { name: "대구", latMin: 35.80, latMax: 35.90, lngMin: 128.50, lngMax: 128.65, districts: ["수성구", "중구", "동구", "북구", "달서구"] },
    { name: "인천", latMin: 37.35, latMax: 37.55, lngMin: 126.60, lngMax: 126.75, districts: ["연수구", "남동구", "부평구", "미추홀구", "서구"] },
    { name: "광주", latMin: 35.10, latMax: 35.20, lngMin: 126.80, lngMax: 126.95, districts: ["동구", "서구", "남구", "북구", "광산구"] },
    { name: "대전", latMin: 36.30, latMax: 36.42, lngMin: 127.32, lngMax: 127.45, districts: ["유성구", "서구", "중구", "동구", "대덕구"] },
    { name: "울산", latMin: 35.50, latMax: 35.60, lngMin: 129.25, lngMax: 129.38, districts: ["남구", "중구", "북구", "울주군"] },
    { name: "경기", latMin: 37.20, latMax: 37.40, lngMin: 126.90, lngMax: 127.20, districts: ["수원시 영통구", "성남시 분당구", "고양시 일산동구", "용인시 수지구", "안양시 동안구", "부천시"] }
  ];

  const brandPrefix = ["황금", "바삭", "인생", "백년", "진짜", "명가", "오리지널", "시골", "소문난", "모던", "수제", "도쿄", "경성", "경양", "하루", "미스터"];
  const brandSuffix = ["카츠", "돈가스", "돈까스", "식당", "하우스", "공방", "클럽", "부엌", "테이블", "키친", "정", "옥", "야"];
  const menus = [
    { name: "로스카츠 (등심)", price: "12,000원", type: "japanese" },
    { name: "히레카츠 (안심)", price: "13,500원", type: "japanese" },
    { name: "경양식 왕돈가스", price: "10,500원", type: "korean" },
    { name: "치즈 듬뿍 카츠", price: "14,000원", type: "japanese" },
    { name: "매운 돈가스", price: "11,000원", type: "korean" },
    { name: "모둠 카츠 정식", price: "16,000원", type: "japanese" },
    { name: "치킨 가스", price: "10,000원", type: "korean" },
    { name: "구마 카츠 (고구마무스)", price: "13,000원", type: "japanese" }
  ];

  const streets = ["중앙로", "대학로", "백범로", "테헤란로", "수송로", "가야대로", "달구벌대로", "예술로", "한밭대로", "봉선로", "충민로", "경수대로", "불정로"];

  function getRandomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function getRandomFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function generateRestaurants() {
    const list = [];
    const count = 1050; // Total count over 1,000

    for (let i = 0; i < count; i++) {
      const city = getRandomElement(cities);
      const district = getRandomElement(city.districts);
      const street = getRandomElement(streets) + " " + getRandomInt(1, 250) + "길";
      
      const lat = getRandomFloat(city.latMin, city.latMax);
      const lng = getRandomFloat(city.lngMin, city.lngMax);

      const brand = getRandomElement(brandPrefix) + getRandomElement(brandSuffix);
      const branch = (Math.random() > 0.3) ? ` ${city.name}${getRandomInt(1, 5)}호점` : " 본점";
      const name = brand + branch;

      const menuObj = getRandomElement(menus);
      const address = `${city.name}시 ${district} ${street}`;
      const phone = `0${getRandomInt(2, 64)}-${getRandomInt(100, 999)}-${getRandomInt(1000, 9999)}`;
      
      const priceCategory = menuObj.price.replace(/[^0-9]/g, "") >= 13000 ? "10k_20k" : "10k_less";

      list.push({
        name: name,
        address: address,
        phone: phone,
        business_hours: "매일 11:00 - 21:00 (브레이크타임 15:00 - 17:00)",
        main_menu: `${menuObj.name} (${menuObj.price})`,
        category: menuObj.type,
        price_range: priceCategory,
        latitude: parseFloat(lat.toFixed(6)),
        longitude: parseFloat(lng.toFixed(6)),
        avg_rating: 0.0,
        review_count: 0,
        image_url: null, // Initial placeholder
        approved: true // Seeded data is pre-approved for convenience
      });
    }

    return list;
  }

  return {
    generate: generateRestaurants
  };
})();
