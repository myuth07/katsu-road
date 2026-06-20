/**
 * Katsu Road (돈가스로드) - Core Application Logic
 * Integrates Kakao Maps API and Supabase Client
 */

let supabaseClient = null;
let kakaoMap = null;
let mapMarkers = []; // Pool to keep track of current map markers
let geocoder = null;

// Application State
const state = {
  user: null,
  restaurants: [],       // All restaurants loaded from DB
  filteredRestaurants: [], // Restaurants currently active after search & filter
  bookmarks: [],         // Bookmarks for the logged-in user: { restaurant_id, is_visited }
  currentRestaurant: null,
  activeCategory: 'all',
  activePrice: 'all',
  activeSort: 'rating',
  searchQuery: '',
  isMobile: window.innerWidth <= 768,
  activeView: 'map',     // 'map', 'list', 'mypage' (For mobile tab layout)
  bottomSheetState: 'collapsed', // 'collapsed', 'partial', 'full'
  selectedRating: 0      // Temp state for review writing
};

// ==========================================
// 1. Initialization
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
  initSupabase();
  loadKakaoMaps();
  setupEventListeners();
  initResponsiveSetup();
});

// Initialize Supabase Client
function initSupabase() {
  if (typeof supabase === 'undefined') {
    showToast("Supabase SDK를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.", "danger");
    return;
  }
  
  if (CONFIG.SUPABASE_URL === "YOUR_SUPABASE_URL" || CONFIG.SUPABASE_ANON_KEY === "YOUR_SUPABASE_ANON_KEY") {
    showToast("Supabase API 키가 설정되지 않았습니다. config.js를 먼저 수정해 주세요.", "warning");
    return;
  }

  supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  
  // Listen for Authentication changes
  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (session && session.user) {
      // Fetch user profile from public.profiles to get nickname and role
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();
        
      if (!error && data) {
        state.user = data;
      } else {
        // Fallback to auth metadata if profile trigger is delayed
        state.user = {
          id: session.user.id,
          email: session.user.email,
          nickname: session.user.user_metadata.nickname || session.user.email.split('@')[0],
          role: 'user'
        };
      }
      
      // Load user specific data
      await loadUserBookmarks();
    } else {
      state.user = null;
      state.bookmarks = [];
    }
    
    updateAuthUI();
    loadRestaurants(); // Reload to refresh marker states (user bookmarks / admin approvals)
  });
}

// Dynamically Load Kakao Maps script with API key
function loadKakaoMaps() {
  if (CONFIG.KAKAO_MAP_API_KEY === "YOUR_KAKAO_MAP_API_KEY") {
    showToast("Kakao Map API 키가 설정되지 않았습니다. config.js를 수정해 주세요.", "warning");
    // Render a mock empty map area
    document.getElementById("map").innerHTML = `
      <div class="empty-state" style="height: 100%; display: flex; justify-content: center; align-items: center; flex-direction: column;">
        <i data-lucide="map"></i>
        <h3>지도 로드 실패</h3>
        <p>config.js 파일에 올바른 카카오맵 API 키를 입력해 주세요.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const script = document.createElement("script");
  script.type = "text/javascript";
  // Kakao Map SDK requires autoload=false to load dynamically
  script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${CONFIG.KAKAO_MAP_API_KEY}&libraries=services&autoload=false`;
  script.async = true;
  script.onload = () => {
    kakao.maps.load(() => {
      initMap();
    });
  };
  script.onerror = () => {
    showToast("Kakao Maps API 로드 실패", "danger");
  };
  document.head.appendChild(script);
}

// Initialize Map Canvas
function initMap() {
  const container = document.getElementById('map');
  const options = {
    center: new kakao.maps.LatLng(37.566826, 126.9786567), // Seoul City Hall default
    level: 7
  };

  kakaoMap = new kakao.maps.Map(container, options);
  geocoder = new kakao.maps.services.Geocoder();
  
  // Sync map center if GPS location is fetched
  moveToCurrentPosition(false);
}

// ==========================================
// 2. Data Loading & Seeding
// ==========================================
async function loadRestaurants() {
  if (!supabaseClient) return;

  // Show loading spinner
  const container = document.getElementById("restaurant-cards-container");
  container.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>돈가스 맛집 불러오는 중...</p>
    </div>
  `;

  // Fetch approved restaurants
  const { data, error } = await supabaseClient
    .from('restaurants')
    .select('*');

  if (error) {
    showToast("식당 데이터를 불러오지 못했습니다.", "danger");
    container.innerHTML = `<p class="empty-state"><i data-lucide="alert-triangle"></i>에러 발생: ${error.message}</p>`;
    lucide.createIcons();
    return;
  }

  state.restaurants = data || [];
  filterAndRenderRestaurants();
}

async function loadUserBookmarks() {
  if (!supabaseClient || !state.user) return;
  const { data, error } = await supabaseClient
    .from('bookmarks')
    .select('restaurant_id, is_visited')
    .eq('user_id', state.user.id);

  if (!error) {
    state.bookmarks = data || [];
  }
}

// Database Seeder running from the client dashboard
async function runDatabaseSeeder() {
  if (!supabaseClient || !state.user || state.user.role !== 'admin') {
    showToast("관리자만 데이터를 시딩할 수 있습니다.", "danger");
    return;
  }

  const btn = document.getElementById("btn-run-seeder");
  const progressBox = document.getElementById("seeder-progress-box");
  const progressBar = document.getElementById("seeder-progress-bar");
  const progressText = document.getElementById("seeder-progress-text");

  btn.disabled = true;
  progressBox.classList.remove("hidden");
  
  try {
    const seedList = SEED_DATA.generate();
    const batchSize = 50;
    const total = seedList.length;
    let inserted = 0;

    progressText.innerText = `총 ${total}개 매장 중 생성 중...`;
    
    for (let i = 0; i < total; i += batchSize) {
      const batch = seedList.slice(i, i + batchSize);
      
      const { error } = await supabaseClient
        .from('restaurants')
        .insert(batch);
        
      if (error) throw error;
      
      inserted += batch.length;
      const pct = Math.round((inserted / total) * 100);
      progressBar.style.width = `${pct}%`;
      progressText.innerText = `적재 중... (${inserted}/${total})`;
    }

    showToast("1,050개 맛집 데이터 시딩이 성공적으로 완료되었습니다!", "success");
    btn.classList.add("hidden");
    loadRestaurants();
  } catch (err) {
    showToast(`시딩 실패: ${err.message}`, "danger");
    btn.disabled = false;
  }
}

// ==========================================
// 3. Search, Filters, Sorting
// ==========================================
function filterAndRenderRestaurants() {
  let list = [...state.restaurants];

  // A. Category Filter (일식 / 경양식)
  if (state.activeCategory !== 'all') {
    list = list.filter(item => item.category === state.activeCategory);
  }

  // B. Price Filter
  if (state.activePrice !== 'all') {
    list = list.filter(item => item.price_range === state.activePrice);
  }

  // C. Search Query (Text Matching)
  if (state.searchQuery.trim() !== '') {
    const q = state.searchQuery.toLowerCase().trim();
    list = list.filter(item => 
      item.name.toLowerCase().includes(q) || 
      item.address.toLowerCase().includes(q) || 
      (item.main_menu && item.main_menu.toLowerCase().includes(q))
    );
  }

  // D. Sorting
  if (state.activeSort === 'rating') {
    list.sort((a, b) => b.avg_rating - a.avg_rating);
  } else if (state.activeSort === 'reviews') {
    list.sort((a, b) => b.review_count - a.review_count);
  } else if (state.activeSort === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  state.filteredRestaurants = list;
  
  // Render Lists
  renderRestaurantCards();
  
  // Update Map Markers
  renderMapMarkers();
}

function renderRestaurantCards() {
  const container = document.getElementById("restaurant-cards-container");
  const countSpan = document.getElementById("restaurant-count");
  
  countSpan.innerText = state.filteredRestaurants.length;
  
  if (state.filteredRestaurants.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="search-code"></i>
        <p>검색 조건에 맞는 돈가스 맛집이 없습니다.</p>
      </div>
    `;
    lucide.createIcons();
    mirrorContentToMobile();
    return;
  }

  let html = '';
  state.filteredRestaurants.forEach(item => {
    // Check user bookmarks / visited status
    const bk = state.bookmarks.find(b => b.restaurant_id === item.id);
    const isBookmarked = !!bk;
    const isVisited = bk ? bk.is_visited : false;

    const ratingVal = parseFloat(item.avg_rating).toFixed(1);
    const categoryName = item.category === 'japanese' ? '일식카츠' : '경양식';
    const thumbnail = item.image_url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=200&auto=format&fit=crop&q=60';

    html += `
      <div class="restaurant-card" data-id="${item.id}">
        <div class="restaurant-card-image">
          <img src="${thumbnail}" alt="${item.name}" loading="lazy">
        </div>
        <div class="restaurant-card-info">
          <h4>${item.name}</h4>
          <div class="address"><i data-lucide="map-pin"></i> ${item.address.split(' ').slice(0, 3).join(' ')}</div>
          <div class="restaurant-meta-row">
            <span class="rating"><i data-lucide="star"></i> ${ratingVal}</span>
            <span class="reviews">리뷰 ${item.review_count}</span>
            <span class="category-tag">${categoryName}</span>
          </div>
        </div>
        <div class="card-bookmark-badge">
          ${isVisited ? '<span class="badge-dot visited" title="방문 완료"></span>' : ''}
          ${isBookmarked && !isVisited ? '<span class="badge-dot bookmarked" title="즐겨찾기"></span>' : ''}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  lucide.createIcons();

  // Attach card click events
  container.querySelectorAll(".restaurant-card").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-id");
      showRestaurantDetail(id);
    });
  });

  mirrorContentToMobile();
}

// Synchronize PC sidebar content to mobile bottom sheet
function mirrorContentToMobile() {
  if (state.isMobile) {
    const mainContent = document.getElementById("sidebar-main-content").innerHTML;
    document.getElementById("bottom-sheet-content-area").innerHTML = mainContent;
    
    // Rebind detail clicks in bottom sheet
    document.querySelectorAll("#bottom-sheet-content-area .restaurant-card").forEach(card => {
      card.addEventListener("click", () => {
        const id = card.getAttribute("data-id");
        showRestaurantDetail(id);
      });
    });

    // Rebind back button in bottom sheet
    const backBtn = document.querySelector("#bottom-sheet-content-area #btn-detail-back");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        hideRestaurantDetail();
      });
    }

    // Rebind details action buttons & route maps inside bottom sheet
    const detailContainer = document.querySelector("#bottom-sheet-content-area #restaurant-detail-container");
    if (detailContainer && state.currentRestaurant) {
      bindDetailSubActions("#bottom-sheet-content-area");
    }
  }
}

// ==========================================
// 4. Map Marker Management
// ==========================================
function renderMapMarkers() {
  if (!kakaoMap) return;

  // Clear existing markers
  mapMarkers.forEach(m => m.setMap(null));
  mapMarkers = [];

  state.filteredRestaurants.forEach(item => {
    const position = new kakao.maps.LatLng(item.latitude, item.longitude);
    
    // Customize marker based on bookmark state
    const bk = state.bookmarks.find(b => b.restaurant_id === item.id);
    let markerColor = 'brown'; // default standard tonkatsu color
    let markerImageSrc = 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png'; // Fallback
    
    // Customize marker icon
    // Using Kakao's standard markers for ease, colored circle custom overlays are premium
    let imageSize = new kakao.maps.Size(24, 35);
    
    if (bk) {
      if (bk.is_visited) {
        // Visited -> Green pin icon overlay
        markerImageSrc = 'https://maps.google.com/mapfiles/ms/icons/green-dot.png';
        imageSize = new kakao.maps.Size(32, 32);
      } else {
        // Bookmarked -> Yellow pin icon overlay
        markerImageSrc = 'https://maps.google.com/mapfiles/ms/icons/yellow-dot.png';
        imageSize = new kakao.maps.Size(32, 32);
      }
    } else {
      // Standard -> Orange/Red pin
      markerImageSrc = 'https://maps.google.com/mapfiles/ms/icons/red-dot.png';
      imageSize = new kakao.maps.Size(32, 32);
    }

    const markerImage = new kakao.maps.MarkerImage(markerImageSrc, imageSize);
    
    const marker = new kakao.maps.Marker({
      position: position,
      image: markerImage,
      clickable: true
    });

    marker.setMap(kakaoMap);
    
    // Add Click Handler
    kakao.maps.event.addListener(marker, 'click', () => {
      showRestaurantDetail(item.id);
      kakaoMap.panTo(position);
    });

    mapMarkers.push(marker);
  });
}

// GPS Current Position
function moveToCurrentPosition(zoom = true) {
  if (!kakaoMap) return;
  
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const locPosition = new kakao.maps.LatLng(lat, lng);
        
        kakaoMap.panTo(locPosition);
        if (zoom) kakaoMap.setLevel(4);
        
        // Add a floating marker to represent user
        const userMarker = new kakao.maps.Marker({
          map: kakaoMap,
          position: locPosition,
          title: "내 현재 위치",
          image: new kakao.maps.MarkerImage(
            'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/pin_car.png', // Small flag or car pin
            new kakao.maps.Size(28, 28)
          )
        });
      },
      () => {
        if (zoom) showToast("GPS 권한을 획득하지 못했습니다.", "warning");
      }
    );
  } else {
    showToast("이 브라우저에서는 위치 서비스를 사용할 수 없습니다.", "warning");
  }
}

// ==========================================
// 5. Restaurant Details & Review Module
// ==========================================
async function showRestaurantDetail(id) {
  const item = state.restaurants.find(r => r.id === id);
  if (!item) return;

  state.currentRestaurant = item;

  // Toggle visible sub-panel
  document.getElementById("panel-restaurant-list").classList.remove("active");
  document.getElementById("panel-restaurant-detail").classList.add("active");

  const container = document.getElementById("restaurant-detail-container");
  container.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>가게 정보를 가공 중...</p>
    </div>
  `;

  // Focus map center on restaurant
  if (kakaoMap) {
    const pos = new kakao.maps.LatLng(item.latitude, item.longitude);
    kakaoMap.panTo(pos);
  }

  // Load reviews from Supabase
  const { data: reviews, error } = await supabaseClient
    .from('reviews')
    .select(`
      id,
      rating,
      content,
      image_url,
      is_reported,
      created_at,
      profiles ( nickname )
    `)
    .eq('restaurant_id', item.id)
    .order('created_at', { ascending: false });

  const bk = state.bookmarks.find(b => b.restaurant_id === item.id);
  const isBookmarked = !!bk;
  const isVisited = bk ? bk.is_visited : false;

  const thumbnail = item.image_url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&auto=format&fit=crop&q=80';
  const categoryStr = item.category === 'japanese' ? '일식 돈가스 (카츠)' : '경양식 돈가스';
  const priceStr = item.price_range === '10k_less' ? '~1만원 이하' : item.price_range === '10k_20k' ? '1만~2만원' : '2만원 이상';

  // Build detail UI html
  let html = `
    <div class="detail-image">
      <img src="${thumbnail}" alt="${item.name}">
    </div>

    <div class="detail-header-block">
      <div>
        <h2>${item.name}</h2>
        <div class="restaurant-meta-row" style="margin-top: 6px;">
          <span class="rating"><i data-lucide="star"></i> ${parseFloat(item.avg_rating).toFixed(1)}</span>
          <span class="reviews">리뷰 ${item.review_count}</span>
        </div>
      </div>
      <div class="detail-actions">
        <button class="detail-action-btn ${isBookmarked && !isVisited ? 'active-bookmark' : ''}" id="btn-toggle-bookmark" title="즐겨찾기">
          <i data-lucide="star"></i>
        </button>
        <button class="detail-action-btn ${isVisited ? 'active-visited' : ''}" id="btn-toggle-visited" title="방문 완료">
          <i data-lucide="check-circle-2"></i>
        </button>
      </div>
    </div>

    <div class="detail-info-list">
      <div class="detail-info-item">
        <i data-lucide="map-pin"></i>
        <div>
          <span>주소</span>
          <p>${item.address}</p>
        </div>
      </div>
      ${item.phone ? `
      <div class="detail-info-item">
        <i data-lucide="phone"></i>
        <div>
          <span>전화번호</span>
          <p>${item.phone}</p>
        </div>
      </div>` : ''}
      <div class="detail-info-item">
        <i data-lucide="clock"></i>
        <div>
          <span>영업시간</span>
          <p>${item.business_hours || '정보 없음'}</p>
        </div>
      </div>
      <div class="detail-info-item">
        <i data-lucide="utensils"></i>
        <div>
          <span>대표 메뉴 / 가격대</span>
          <p>${item.main_menu} (${priceStr}, ${categoryStr})</p>
        </div>
      </div>
    </div>

    <!-- Kakao Navigation Link -->
    <a href="https://map.kakao.com/link/to/${encodeURIComponent(item.name)},${item.latitude},${item.longitude}" 
       target="_blank" class="btn-route-link">
       <i data-lucide="navigation"></i> 카카오맵 길찾기 연결
    </a>

    <div class="detail-reviews-header">
      <h3>리뷰 목록 <span style="font-weight: 500; font-size: 0.85rem; color: var(--text-muted);">${reviews ? reviews.length : 0}</span></h3>
      <button class="btn btn-primary btn-sm" id="btn-write-review-trigger">리뷰 작성</button>
    </div>

    <div class="reviews-list-box">
  `;

  if (!reviews || reviews.length === 0) {
    html += `<p class="empty-state"><i data-lucide="message-square"></i>첫 번째 맛 평가를 남겨보세요!</p>`;
  } else {
    reviews.forEach(rev => {
      const stars = Array(5).fill(0).map((_, i) => 
        `<i data-lucide="star" class="${i < rev.rating ? 'fill' : ''}"></i>`
      ).join('');

      html += `
        <div class="review-card" data-rev-id="${rev.id}">
          <div class="review-author-row">
            <span class="user-info"><i data-lucide="user"></i> ${rev.profiles ? rev.profiles.nickname : '익명'}</span>
            <span class="date">${new Date(rev.created_at).toLocaleDateString()}</span>
          </div>
          <div class="review-stars-row">
            <div class="review-stars">${stars}</div>
          </div>
          <p class="review-content">${rev.content}</p>
          ${rev.image_url ? `
          <div class="review-image-attached">
            <img src="${rev.image_url}" alt="리뷰 이미지" onclick="window.open('${rev.image_url}', '_blank')">
          </div>` : ''}
          
          <div class="review-actions-menu">
            <button class="btn-report-review ${rev.is_reported ? 'reported' : ''}" data-action="report">
              <i data-lucide="flag"></i> ${rev.is_reported ? '신고 완료됨' : '신고하기'}
            </button>
          </div>
        </div>
      `;
    });
  }

  html += `</div>`;
  container.innerHTML = html;
  lucide.createIcons();

  // If in mobile layout, snap bottom sheet to partial/full view
  if (state.isMobile) {
    expandBottomSheet('full');
  }

  // Bind details actions
  bindDetailSubActions("#sidebar-main-content");
  mirrorContentToMobile();
}

function bindDetailSubActions(parentSelector) {
  const parent = document.querySelector(parentSelector);
  if (!parent) return;

  const item = state.currentRestaurant;

  // Toggle Bookmark
  const bookmarkBtn = parent.querySelector("#btn-toggle-bookmark");
  if (bookmarkBtn) {
    bookmarkBtn.addEventListener("click", async () => {
      if (!requireAuth()) return;
      const bk = state.bookmarks.find(b => b.restaurant_id === item.id);
      
      if (bk) {
        // Delete bookmark
        const { error } = await supabaseClient
          .from('bookmarks')
          .delete()
          .eq('user_id', state.user.id)
          .eq('restaurant_id', item.id);

        if (!error) {
          showToast("즐겨찾기 해제되었습니다.");
          state.bookmarks = state.bookmarks.filter(b => b.restaurant_id !== item.id);
        }
      } else {
        // Add bookmark
        const { error } = await supabaseClient
          .from('bookmarks')
          .insert({ user_id: state.user.id, restaurant_id: item.id, is_visited: false });

        if (!error) {
          showToast("즐겨찾기에 저장되었습니다.", "success");
          state.bookmarks.push({ restaurant_id: item.id, is_visited: false });
        }
      }
      showRestaurantDetail(item.id);
    });
  }

  // Toggle Visited status
  const visitedBtn = parent.querySelector("#btn-toggle-visited");
  if (visitedBtn) {
    visitedBtn.addEventListener("click", async () => {
      if (!requireAuth()) return;
      const bk = state.bookmarks.find(b => b.restaurant_id === item.id);
      
      if (bk) {
        // Toggle visited true/false
        const nextVisited = !bk.is_visited;
        const { error } = await supabaseClient
          .from('bookmarks')
          .update({ is_visited: nextVisited })
          .eq('user_id', state.user.id)
          .eq('restaurant_id', item.id);

        if (!error) {
          bk.is_visited = nextVisited;
          showToast(nextVisited ? "방문 완료 매장으로 등록되었습니다." : "방문 완료가 해제되었습니다.", "success");
        }
      } else {
        // Insert as bookmarked AND visited = true
        const { error } = await supabaseClient
          .from('bookmarks')
          .insert({ user_id: state.user.id, restaurant_id: item.id, is_visited: true });

        if (!error) {
          state.bookmarks.push({ restaurant_id: item.id, is_visited: true });
          showToast("방문 완료 매장으로 등록되었습니다.", "success");
        }
      }
      showRestaurantDetail(item.id);
    });
  }

  // Write Review Modal Trigger
  const writeReviewBtn = parent.querySelector("#btn-write-review-trigger");
  if (writeReviewBtn) {
    writeReviewBtn.addEventListener("click", () => {
      if (!requireAuth()) return;
      
      document.getElementById("review-restaurant-id").value = item.id;
      document.getElementById("review-modal-restaurant-name").innerText = `${item.name} 리뷰 쓰기`;
      
      // Reset stars
      state.selectedRating = 0;
      document.querySelectorAll("#review-star-rating i").forEach(star => star.classList.remove("active"));
      document.getElementById("review-rating-value").value = "";
      document.getElementById("review-content").value = "";
      document.getElementById("review-photo").value = "";
      document.getElementById("review-photo-preview-box").classList.add("hidden");

      openModal("review-modal");
    });
  }

  // Report Review Action
  parent.querySelectorAll(".btn-report-review").forEach(reportBtn => {
    reportBtn.addEventListener("click", async (e) => {
      const card = e.currentTarget.closest(".review-card");
      const revId = card.getAttribute("data-rev-id");
      
      const { error } = await supabaseClient
        .from('reviews')
        .update({ is_reported: true })
        .eq('id', revId);

      if (!error) {
        showToast("신고 처리 대기 중으로 등록되었습니다.");
        e.currentTarget.classList.add("reported");
        e.currentTarget.innerHTML = `<i data-lucide="flag"></i> 신고 완료됨`;
        lucide.createIcons();
      }
    });
  });
}

function hideRestaurantDetail() {
  state.currentRestaurant = null;
  document.getElementById("panel-restaurant-detail").classList.remove("active");
  document.getElementById("panel-restaurant-list").classList.add("active");
  
  if (state.isMobile) {
    expandBottomSheet('partial');
  }
  filterAndRenderRestaurants();
}

// Review submission with client side image compression
async function handleReviewSubmit(e) {
  e.preventDefault();
  if (!supabaseClient || !state.user) return;

  const restaurantId = document.getElementById("review-restaurant-id").value;
  const rating = parseInt(document.getElementById("review-rating-value").value);
  const content = document.getElementById("review-content").value;
  const fileInput = document.getElementById("review-photo");
  
  let imageUrl = null;

  // Check rating
  if (!rating || rating < 1) {
    showToast("평점 별점을 최소 1점 이상 선택해주세요.", "warning");
    return;
  }

  showToast("리뷰 업로드 중...");

  // Handle optional photo compression & upload
  if (fileInput.files.length > 0) {
    const file = fileInput.files[0];
    
    // Client-side image compression
    const options = {
      maxSizeMB: 0.9,
      maxWidthOrHeight: 1200,
      useWebWorker: true
    };
    
    try {
      const compressedFile = await imageCompression(file, options);
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}.${fileExt}`;
      const filePath = `reviews/${fileName}`;

      // Upload file to Supabase Storage Bucket ('reviews')
      const { data, error: uploadError } = await supabaseClient.storage
        .from('reviews')
        .upload(filePath, compressedFile);

      if (uploadError) throw uploadError;

      // Generate public URL
      const { data: publicUrlData } = supabaseClient.storage
        .from('reviews')
        .getPublicUrl(filePath);

      imageUrl = publicUrlData.publicUrl;
    } catch (compressionError) {
      showToast("이미지 업로드에 실패했습니다.", "danger");
      return;
    }
  }

  // Insert review row
  const { error } = await supabaseClient
    .from('reviews')
    .insert({
      restaurant_id: restaurantId,
      user_id: state.user.id,
      rating: rating,
      content: content,
      image_url: imageUrl
    });

  if (error) {
    showToast(`리뷰 저장 오류: ${error.message}`, "danger");
  } else {
    showToast("소중한 리뷰가 정상 등록되었습니다!", "success");
    closeModal("review-modal");
    // Reload details to show review
    showRestaurantDetail(restaurantId);
  }
}

// ==========================================
// 6. User Restaurant Registration Module
// ==========================================
async function handleRestaurantRegisterSubmit(e) {
  e.preventDefault();
  if (!supabaseClient || !requireAuth()) return;

  const name = document.getElementById("reg-name").value;
  const address = document.getElementById("reg-address").value;
  const phone = document.getElementById("reg-phone").value;
  const category = document.getElementById("reg-category").value;
  const price = document.getElementById("reg-price").value;
  const menu = document.getElementById("reg-menu").value;
  const hours = document.getElementById("reg-hours").value;
  const lat = parseFloat(document.getElementById("reg-lat").value);
  const lng = parseFloat(document.getElementById("reg-lng").value);
  const fileInput = document.getElementById("reg-photo");

  if (!lat || !lng) {
    showToast("가게 위치(좌표) 정보를 특정하지 못했습니다. 주소 찾기 버튼으로 검색해 주세요.", "warning");
    return;
  }

  showToast("맛집 제보 정보를 등록 중입니다...");

  let imageUrl = null;

  if (fileInput.files.length > 0) {
    const file = fileInput.files[0];
    const options = { maxSizeMB: 0.9, maxWidthOrHeight: 1200 };
    try {
      const compressedFile = await imageCompression(file, options);
      const filePath = `restaurants/${Date.now()}-${file.name}`;
      
      const { error: uploadError } = await supabaseClient.storage
        .from('restaurants')
        .upload(filePath, compressedFile);
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabaseClient.storage
        .from('restaurants')
        .getPublicUrl(filePath);

      imageUrl = publicUrlData.publicUrl;
    } catch (err) {
      showToast("이미지 업로드에 실패했습니다.", "danger");
      return;
    }
  }

  // Insert pending approval restaurant
  const { error } = await supabaseClient
    .from('restaurants')
    .insert({
      name: name,
      address: address,
      phone: phone,
      category: category,
      price_range: price,
      main_menu: menu,
      business_hours: hours,
      latitude: lat,
      longitude: lng,
      image_url: imageUrl,
      approved: false // Set to false to trigger admin approval workflow
    });

  if (error) {
    showToast(`제보 실패: ${error.message}`, "danger");
  } else {
    showToast("맛집 제보가 정상 처리되었습니다. 관리자 승인 후 지도에 노출됩니다.", "success");
    closeModal("register-modal");
  }
}

// ==========================================
// 7. Modals, Panels & Tabs routing (SPA Style)
// ==========================================
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

// View Switches
async function showMyPage() {
  if (!requireAuth()) return;

  openModal("mypage-panel");
  document.getElementById("mypage-nickname").innerText = state.user.nickname;
  document.getElementById("mypage-email").innerText = state.user.email;

  // Load My Bookmarks
  const { data: bookmarksData } = await supabaseClient
    .from('bookmarks')
    .select(`
      is_visited,
      restaurants ( id, name, address, avg_rating, category )
    `)
    .eq('user_id', state.user.id);

  const container = document.getElementById("my-bookmarks-container");
  if (!bookmarksData || bookmarksData.length === 0) {
    container.innerHTML = `<p class="empty-state">즐겨찾기한 돈가스집이 없습니다.</p>`;
  } else {
    let html = '';
    bookmarksData.forEach(b => {
      const r = b.restaurants;
      if (!r) return;
      html += `
        <div class="restaurant-card" data-id="${r.id}" style="padding: 12px; margin-bottom: 0;">
          <div class="restaurant-card-info">
            <h4 style="font-size: 0.95rem;">${r.name}</h4>
            <div class="address" style="margin-bottom: 4px;">${r.address.split(' ').slice(0, 2).join(' ')}</div>
            <div class="restaurant-meta-row" style="font-size: 0.75rem;">
              <span class="rating"><i data-lucide="star"></i> ${parseFloat(r.avg_rating).toFixed(1)}</span>
              <span class="category-tag">${r.category === 'japanese' ? '일식' : '경양식'}</span>
            </div>
          </div>
          <div class="card-bookmark-badge">
            ${b.is_visited ? '<span class="badge-dot visited" title="방문함"></span>' : '<span class="badge-dot bookmarked" title="가고싶음"></span>'}
          </div>
        </div>
      `;
    });
    container.innerHTML = html;
    lucide.createIcons();
    
    container.querySelectorAll(".restaurant-card").forEach(card => {
      card.addEventListener("click", () => {
        closeModal("mypage-panel");
        showRestaurantDetail(card.getAttribute("data-id"));
      });
    });
  }

  // Load My Reviews
  const { data: reviewsData } = await supabaseClient
    .from('reviews')
    .select(`
      id, rating, content, created_at,
      restaurants ( name )
    `)
    .eq('user_id', state.user.id);

  const reviewsContainer = document.getElementById("my-reviews-container");
  if (!reviewsData || reviewsData.length === 0) {
    reviewsContainer.innerHTML = `<p class="empty-state">작성한 맛 후기가 없습니다.</p>`;
  } else {
    let html = '';
    reviewsData.forEach(rev => {
      const stars = '★'.repeat(rev.rating) + '☆'.repeat(5 - rev.rating);
      html += `
        <div class="review-card" style="padding: 12px 0;">
          <div style="font-weight: 700; color: var(--primary);">${rev.restaurants ? rev.restaurants.name : '식당 정보 없음'}</div>
          <div style="color: #F59E0B; font-size: 0.8rem; margin: 4px 0;">${stars}</div>
          <p style="font-size: 0.85rem; color: var(--text-medium);">${rev.content}</p>
        </div>
      `;
    });
    reviewsContainer.innerHTML = html;
  }
}

// Show Admin dashboard
async function showAdminDashboard() {
  if (!state.user || state.user.role !== 'admin') {
    showToast("관리자만 접근이 가능합니다.", "danger");
    return;
  }

  openModal("admin-panel");
  loadAdminStats();
  loadAdminPendingList();
  loadAdminReportedReviews();
}

async function loadAdminStats() {
  const { count: totalCount } = await supabaseClient.from('restaurants').select('*', { count: 'exact', head: true });
  const { count: pendingCount } = await supabaseClient.from('restaurants').select('*', { count: 'exact', head: true }).eq('approved', false);
  const { count: reportedCount } = await supabaseClient.from('reviews').select('*', { count: 'exact', head: true }).eq('is_reported', true);

  document.getElementById("stat-total-restaurants").innerText = totalCount || 0;
  document.getElementById("stat-pending-restaurants").innerText = pendingCount || 0;
  document.getElementById("stat-reported-reviews").innerText = reportedCount || 0;
}

async function loadAdminPendingList() {
  const { data, error } = await supabaseClient
    .from('restaurants')
    .select('*')
    .eq('approved', false);

  const container = document.getElementById("admin-pending-container");
  if (!data || data.length === 0) {
    container.innerHTML = `<p class="empty-state">승인 대기 중인 맛집 제보가 없습니다.</p>`;
    return;
  }

  let html = '';
  data.forEach(item => {
    html += `
      <div class="restaurant-card" style="flex-direction: column;" data-id="${item.id}">
        <div style="display:flex; gap:16px;">
          <div class="restaurant-card-info">
            <h4>${item.name}</h4>
            <p style="font-size:0.8rem; color:var(--text-medium);">주소: ${item.address}</p>
            <p style="font-size:0.8rem; color:var(--text-medium);">메뉴: ${item.main_menu}</p>
          </div>
        </div>
        <div class="pending-actions-row">
          <button class="btn btn-primary btn-sm btn-approve" data-id="${item.id}">승인</button>
          <button class="btn btn-secondary btn-sm btn-reject" data-id="${item.id}" style="background-color:rgba(220,38,38,0.1); color:var(--status-danger);">반려 및 삭제</button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  
  // Attach admin handlers
  container.querySelectorAll(".btn-approve").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const id = btn.getAttribute("data-id");
      const { error } = await supabaseClient.from('restaurants').update({ approved: true }).eq('id', id);
      if (!error) {
        showToast("식당 제보를 승인하였습니다.", "success");
        loadAdminPendingList();
        loadAdminStats();
      }
    });
  });

  container.querySelectorAll(".btn-reject").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const id = btn.getAttribute("data-id");
      const { error } = await supabaseClient.from('restaurants').delete().eq('id', id);
      if (!error) {
        showToast("제보를 반려(삭제) 처리하였습니다.");
        loadAdminPendingList();
        loadAdminStats();
      }
    });
  });
}

async function loadAdminReportedReviews() {
  const { data } = await supabaseClient
    .from('reviews')
    .select(`
      id, content, rating, is_reported,
      profiles ( nickname ),
      restaurants ( name )
    `)
    .eq('is_reported', true);

  const container = document.getElementById("admin-reported-reviews-container");
  if (!data || data.length === 0) {
    container.innerHTML = `<p class="empty-state">신고 처리 대기 중인 리뷰가 없습니다.</p>`;
    return;
  }

  let html = '';
  data.forEach(rev => {
    html += `
      <div class="review-card" style="padding: 16px; background-color: var(--bg-cream); border-radius: var(--radius-sm); margin-bottom:12px;">
        <div style="font-weight:700;">식당: ${rev.restaurants ? rev.restaurants.name : '알수없음'}</div>
        <p style="font-size:0.8rem; color:var(--text-muted);">작성자: ${rev.profiles ? rev.profiles.nickname : '익명'}</p>
        <p style="font-size:0.9rem; color:var(--status-danger); margin: 6px 0; font-style:italic;">"${rev.content}"</p>
        <div class="pending-actions-row">
          <button class="btn btn-secondary btn-sm btn-delete-reported" data-id="${rev.id}">리뷰 영구 삭제</button>
          <button class="btn btn-primary btn-sm btn-dismiss-reported" data-id="${rev.id}">신고 기각 (복구)</button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll(".btn-delete-reported").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const { error } = await supabaseClient.from('reviews').delete().eq('id', id);
      if (!error) {
        showToast("신고된 리뷰를 데이터베이스에서 파기하였습니다.");
        loadAdminReportedReviews();
        loadAdminStats();
      }
    });
  });

  container.querySelectorAll(".btn-dismiss-reported").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const { error } = await supabaseClient.from('reviews').update({ is_reported: false }).eq('id', id);
      if (!error) {
        showToast("신고를 기각하고 리뷰를 활성화했습니다.", "success");
        loadAdminReportedReviews();
        loadAdminStats();
      }
    });
  });
}

// ==========================================
// 8. Event Listeners Setup
// ==========================================
function setupEventListeners() {
  // Mobile Tab Router
  document.getElementById("nav-map-tab").addEventListener("click", () => switchMobileView('map'));
  document.getElementById("nav-list-tab").addEventListener("click", () => switchMobileView('list'));
  document.getElementById("nav-mypage-tab").addEventListener("click", showMyPage);
  document.getElementById("nav-admin-tab").addEventListener("click", showAdminDashboard);

  // Floating controls inside Map
  document.getElementById("btn-gps-current").addEventListener("click", () => moveToCurrentPosition(true));
  document.getElementById("btn-zoom-in").addEventListener("click", () => kakaoMap && kakaoMap.setLevel(kakaoMap.getLevel() - 1));
  document.getElementById("btn-zoom-out").addEventListener("click", () => kakaoMap && kakaoMap.setLevel(kakaoMap.getLevel() + 1));

  // Search autocomplete & clear
  const searchInput = document.getElementById("search-input");
  const clearBtn = document.getElementById("search-clear-btn");
  
  searchInput.addEventListener("input", (e) => {
    const val = e.target.value;
    state.searchQuery = val;
    
    if (val.length > 0) {
      clearBtn.classList.remove("hidden");
      renderAutocompleteList(val);
    } else {
      clearBtn.classList.add("hidden");
      document.getElementById("autocomplete-list").classList.add("hidden");
      filterAndRenderRestaurants();
    }
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = '';
    state.searchQuery = '';
    clearBtn.classList.add("hidden");
    document.getElementById("autocomplete-list").classList.add("hidden");
    filterAndRenderRestaurants();
  });

  // Filter Pills click events
  document.querySelectorAll(".filter-pill").forEach(pill => {
    pill.addEventListener("click", (e) => {
      document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
      e.target.classList.add("active");
      
      state.activeCategory = e.target.getAttribute("data-category");
      filterAndRenderRestaurants();
    });
  });

  // Selector Filters
  document.getElementById("filter-price").addEventListener("change", (e) => {
    state.activePrice = e.target.value;
    filterAndRenderRestaurants();
  });

  document.getElementById("sort-select").addEventListener("change", (e) => {
    state.activeSort = e.target.value;
    filterAndRenderRestaurants();
  });

  // Modal Closures
  document.getElementById("btn-auth-close").addEventListener("click", () => closeModal("auth-modal"));
  document.getElementById("btn-register-close").addEventListener("click", () => closeModal("register-modal"));
  document.getElementById("btn-review-close").addEventListener("click", () => closeModal("review-modal"));
  document.getElementById("btn-mypage-close").addEventListener("click", () => closeModal("mypage-panel"));
  document.getElementById("btn-admin-close").addEventListener("click", () => closeModal("admin-panel"));

  // Detail View Back button (PC)
  document.getElementById("btn-detail-back").addEventListener("click", hideRestaurantDetail);

  // Authentication Triggers
  document.getElementById("btn-login-trigger").addEventListener("click", () => {
    openModal("auth-modal");
    toggleAuthView("login");
  });
  document.getElementById("btn-go-signup").addEventListener("click", () => toggleAuthView("signup"));
  document.getElementById("btn-go-login").addEventListener("click", () => toggleAuthView("login"));
  document.getElementById("btn-logout").addEventListener("click", handleLogout);

  // Sign in & Sign up Forms Submission
  document.getElementById("form-login").addEventListener("submit", handleLoginSubmit);
  document.getElementById("form-signup").addEventListener("submit", handleSignupSubmit);

  // Review Form Rating Star trigger
  document.querySelectorAll("#review-star-rating i").forEach(star => {
    star.addEventListener("click", (e) => {
      const val = parseInt(e.currentTarget.getAttribute("data-value"));
      state.selectedRating = val;
      document.getElementById("review-rating-value").value = val;
      
      // Update star designs
      document.querySelectorAll("#review-star-rating i").forEach((s, idx) => {
        if (idx < val) {
          s.classList.add("active");
        } else {
          s.classList.remove("active");
        }
      });
    });
  });

  // Review Form Submit
  document.getElementById("form-review").addEventListener("submit", handleReviewSubmit);

  // New Restaurant Register Trigger & Submit
  document.getElementById("btn-add-restaurant-trigger").addEventListener("click", () => {
    if (!requireAuth()) return;
    openModal("register-modal");
    
    // Clear registration values
    document.getElementById("reg-name").value = "";
    document.getElementById("reg-address").value = "";
    document.getElementById("reg-phone").value = "";
    document.getElementById("reg-menu").value = "";
    document.getElementById("reg-hours").value = "";
    document.getElementById("reg-lat").value = "";
    document.getElementById("reg-lng").value = "";
    document.getElementById("reg-photo").value = "";
    document.getElementById("reg-photo-preview-box").classList.add("hidden");
  });

  document.getElementById("form-register-restaurant").addEventListener("submit", handleRestaurantRegisterSubmit);

  // Address lookup helper (Geocoder)
  document.getElementById("btn-reg-address-search").addEventListener("click", () => {
    const defaultAddress = prompt("지보할 식당 주소를 입력해 주세요 (예: 서울 강남구 테헤란로 123)");
    if (!defaultAddress) return;

    if (!geocoder) {
      showToast("Kakao Maps Geocoder가 초기화되지 않았습니다.", "danger");
      return;
    }

    geocoder.addressSearch(defaultAddress, (result, status) => {
      if (status === kakao.maps.services.Status.OK) {
        document.getElementById("reg-address").value = result[0].address_name;
        document.getElementById("reg-lat").value = result[0].y;
        document.getElementById("reg-lng").value = result[0].x;
        showToast("위치가 지도에 정상 지정되었습니다.", "success");
      } else {
        showToast("주소를 찾지 못했습니다. 정확한 지명을 입력해주세요.", "warning");
      }
    });
  });

  // Image Upload File change Previews
  document.getElementById("review-photo").addEventListener("change", (e) => handleImagePreview(e, "review-photo-preview", "review-photo-preview-box"));
  document.getElementById("reg-photo").addEventListener("change", (e) => handleImagePreview(e, "reg-photo-preview", "reg-photo-preview-box"));

  // Panels Tab Swapping
  setupPanelTabs("mypage-panel");
  setupPanelTabs("admin-panel");

  // Database Seeder
  document.getElementById("btn-run-seeder").addEventListener("click", runDatabaseSeeder);

  // Close suggestions on outside click
  window.addEventListener("click", (e) => {
    if (!e.target.closest(".search-box") && !e.target.closest("#autocomplete-list")) {
      document.getElementById("autocomplete-list").classList.add("hidden");
    }
  });

  // Drag handles for Mobile Bottom Sheet
  setupBottomSheetDrag();
}

function handleImagePreview(e, imgId, boxId) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      document.getElementById(imgId).src = event.target.result;
      document.getElementById(boxId).classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  } else {
    document.getElementById(boxId).classList.add("hidden");
  }
}

function setupPanelTabs(panelId) {
  const panel = document.getElementById(panelId);
  panel.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      panel.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      panel.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-target");
      panel.querySelector(`#${targetId}`).classList.add("active");
    });
  });
}

// Autocomplete list matching local restaurants
function renderAutocompleteList(query) {
  const listDiv = document.getElementById("autocomplete-list");
  const filtered = state.restaurants.filter(r => 
    r.name.toLowerCase().includes(query.toLowerCase()) || 
    r.address.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 5); // Limit suggestions

  if (filtered.length === 0) {
    listDiv.classList.add("hidden");
    return;
  }

  listDiv.innerHTML = filtered.map(r => `
    <div class="autocomplete-item" data-id="${r.id}">
      <i data-lucide="map-pin"></i>
      <div>
        <strong>${r.name}</strong>
        <span style="font-size:0.75rem; color:var(--text-muted); display:block;">${r.address}</span>
      </div>
    </div>
  `).join('');

  lucide.createIcons();
  listDiv.classList.remove("hidden");

  // Autocomplete click
  listDiv.querySelectorAll(".autocomplete-item").forEach(item => {
    item.addEventListener("click", () => {
      const id = item.getAttribute("data-id");
      listDiv.classList.add("hidden");
      document.getElementById("search-input").value = state.restaurants.find(r => r.id === id).name;
      state.searchQuery = document.getElementById("search-input").value;
      showRestaurantDetail(id);
    });
  });
}

// ==========================================
// 9. Swipeable Bottom Sheet (Mobile Gestures)
// ==========================================
function setupBottomSheetDrag() {
  const dragHandle = document.getElementById("bottom-sheet-drag");
  const sheet = document.getElementById("bottom-sheet");
  
  let startY = 0;
  let startHeight = 0;

  dragHandle.addEventListener("touchstart", (e) => {
    startY = e.touches[0].clientY;
    sheet.style.transition = 'none'; // Disable animations during drag
  });

  dragHandle.addEventListener("touchmove", (e) => {
    const deltaY = e.touches[0].clientY - startY;
    
    // Simple drag behavior: if swipe down, push panel down
    if (deltaY > 0) {
      sheet.style.transform = `translateY(${deltaY}px)`;
    }
  });

  dragHandle.addEventListener("touchend", (e) => {
    sheet.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    const endY = e.changedTouches[0].clientY;
    const deltaY = endY - startY;

    if (deltaY > 100) {
      // Swiped down -> collapse or shrink
      if (state.bottomSheetState === 'full') {
        expandBottomSheet('partial');
      } else {
        expandBottomSheet('collapsed');
      }
    } else if (deltaY < -100) {
      // Swiped up -> expand
      if (state.bottomSheetState === 'collapsed') {
        expandBottomSheet('partial');
      } else {
        expandBottomSheet('full');
      }
    } else {
      // Reset position to current state
      expandBottomSheet(state.bottomSheetState);
    }
  });
}

function expandBottomSheet(mode) {
  const sheet = document.getElementById("bottom-sheet");
  state.bottomSheetState = mode;

  sheet.classList.remove("open-full", "open-partial");
  
  if (mode === 'full') {
    sheet.classList.add("open-full");
    sheet.style.transform = '';
  } else if (mode === 'partial') {
    sheet.classList.add("open-partial");
    sheet.style.transform = '';
  } else {
    // Collapsed: just showing header bar peek
    sheet.style.transform = `translateY(calc(100% - 60px))`;
  }
}

// Mobile View Tab switching
function switchMobileView(view) {
  state.activeView = view;
  
  document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
  document.getElementById(`nav-${view}-tab`).classList.add("active");

  const sidebar = document.getElementById("sidebar");
  if (view === 'list') {
    sidebar.classList.add("show-sidebar-mobile");
    expandBottomSheet('collapsed'); // Collapse map drawer
  } else {
    sidebar.classList.remove("show-sidebar-mobile");
    if (state.currentRestaurant) {
      expandBottomSheet('full');
    } else {
      expandBottomSheet('partial');
    }
  }
}

// Responsive layout update listener
function initResponsiveSetup() {
  window.addEventListener("resize", () => {
    const isMobile = window.innerWidth <= 768;
    if (isMobile !== state.isMobile) {
      state.isMobile = isMobile;
      location.reload(); // Refresh layout to bind proper mobile/pc event layouts
    }
  });
}

// ==========================================
// 10. User Authentications Logic
// ==========================================
function updateAuthUI() {
  const container = document.getElementById("header-auth-section");
  const adminTab = document.getElementById("nav-admin-tab");
  
  if (state.user) {
    // User is logged in
    const nickname = state.user.nickname || "사용자";
    container.innerHTML = `
      <div class="user-profile-badge" id="btn-mypage-trigger" onclick="showMyPage()">
        <i data-lucide="user"></i>
        <span>${nickname}</span>
      </div>
    `;
    
    // Show admin navigation if user has admin privileges
    if (state.user.role === 'admin') {
      adminTab.classList.remove("hidden");
    } else {
      adminTab.classList.add("hidden");
    }
  } else {
    // Logged out
    container.innerHTML = `<button class="btn btn-primary btn-sm" id="btn-login-trigger-new">로그인 / 가입</button>`;
    adminTab.classList.add("hidden");

    const newTrigger = document.getElementById("btn-login-trigger-new");
    if (newTrigger) {
      newTrigger.addEventListener("click", () => {
        openModal("auth-modal");
        toggleAuthView("login");
      });
    }
  }
  lucide.createIcons();
}

function toggleAuthView(view) {
  const loginView = document.getElementById("auth-view-login");
  const signupView = document.getElementById("auth-view-signup");
  
  if (view === 'signup') {
    loginView.classList.add("hidden");
    signupView.classList.remove("hidden");
  } else {
    loginView.classList.remove("hidden");
    signupView.classList.add("hidden");
  }
}

function requireAuth() {
  if (!state.user) {
    openModal("auth-modal");
    toggleAuthView("login");
    showToast("로그인이 필요한 기능입니다.", "warning");
    return false;
  }
  return true;
}

// Sign up Submit
async function handleSignupSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) return;

  const email = document.getElementById("signup-email").value;
  const nickname = document.getElementById("signup-nickname").value;
  const password = document.getElementById("signup-password").value;
  const confirmPassword = document.getElementById("signup-password-confirm").value;

  if (password !== confirmPassword) {
    showToast("비밀번호가 서로 일치하지 않습니다.", "warning");
    return;
  }

  showToast("가입을 처리하는 중...");

  const { data, error } = await supabaseClient.auth.signUp({
    email: email,
    password: password,
    options: {
      data: {
        nickname: nickname
      }
    }
  });

  if (error) {
    showToast(`가입 실패: ${error.message}`, "danger");
  } else {
    showToast("가입이 완료되었습니다! 로그인 해 주세요.", "success");
    toggleAuthView("login");
  }
}

// Sign in Submit
async function handleLoginSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) return;

  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;

  showToast("로그인을 인증 중...");

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: email,
    password: password
  });

  if (error) {
    showToast(`로그인 실패: ${error.message}`, "danger");
  } else {
    showToast("돈가스로드에 성공적으로 로그인되었습니다!", "success");
    closeModal("auth-modal");
  }
}

// Log out
async function handleLogout() {
  if (!supabaseClient) return;
  
  const { error } = await supabaseClient.auth.signOut();
  if (!error) {
    showToast("안전하게 로그아웃되었습니다.");
    closeModal("mypage-panel");
    closeModal("admin-panel");
  }
}

// ==========================================
// 11. Toast Notifications Utility
// ==========================================
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerText = message;
  
  container.appendChild(toast);

  // Automatically remove toast from DOM after animation completes
  setTimeout(() => {
    toast.remove();
  }, 3000);
}
