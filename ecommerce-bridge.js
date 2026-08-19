(function() {
        let csrfToken = '';
        let ownerMode = false;
        let ownerRefreshTimer = null;
        let currentUser = null;
        let editingProductId = null;
        let productSaveInProgress = false;
        const backendHost = location.hostname === 'localhost' ? 'localhost' : '127.0.0.1';
        const isRenderHost = location.hostname.includes('onrender.com');
        const isStaticPreview = location.protocol === 'file:' || ['5500', '5501'].includes(location.port);
        const apiBase = isStaticPreview ? `http://${backendHost}:5001` : '';
        const apiUrl = url => apiBase + url;
        const assetUrl = url => (url && url.startsWith('/')) ? apiBase + url : url;
        const money = value => 'PKR ' + Number(value || 0).toLocaleString('en-PK');
        const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
        const slugify = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'product';
        const cartCacheKey = 'friendsTradersBackendCart';
        const wishlistCacheKey = 'friendsTradersWishlist';
        window.useBackendCart = true;

        function localWishlist() { try { return JSON.parse(localStorage.getItem(wishlistCacheKey) || '[]'); } catch (_) { return []; } }

        function saveLocalWishlist(items) { localStorage.setItem(wishlistCacheKey, JSON.stringify(items)); }

        function cachedCart() {
            try { return JSON.parse(localStorage.getItem(cartCacheKey) || 'null'); } catch (_) { return null; }
        }

        function cacheCart(cart) {
            if (cart && Array.isArray(cart.items)) localStorage.setItem(cartCacheKey, JSON.stringify(cart));
            return cart;
        }

        async function initCsrf() {
            const response = await fetch(apiUrl('/api/csrf'), { credentials: 'include' });
            const data = await response.json();
            csrfToken = data.csrf_token;
            currentUser = data.user || null;
            return data;
        }

        async function api(url, options = {}, retry = true) {
            const headers = options.body instanceof FormData ? { 'X-CSRF-Token': csrfToken } : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 60000);
            try {
                const response = await fetch(apiUrl(url), { credentials: 'include', ...options, signal: controller.signal, headers: {...headers, ...(options.headers || {}) } });
                const data = await response.json().catch(() => ({}));
                if (response.status === 403 && retry && String(data.error || '').toLowerCase().includes('security token')) {
                    await initCsrf();
                    return api(url, options, false);
                }
                if (!response.ok) throw new Error(data.error || 'Request failed');
                return data;
            } catch (error) {
                if (error.name === 'AbortError') throw new Error('Server response abhi slow hai. Please dobara try karein.');
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        }

        function statusClass(status) {
            return 'status-' + String(status || 'pending').toLowerCase();
        }

        function categoryLabel(category) {
            const labels = {
                rosepetal: 'Rose Petal',
                chef: 'Chef',
                sk: 'SK',
                thermos: 'Thermos',
                plates: 'Plates',
                'cups-mugs': 'Cups & Mugs',
                'glasses-drinkware': 'Glasses & Drinkware',
                'lunch-boxes': 'Lunch Boxes',
                'water-bottles': 'Water Bottles',
                dinnerware: 'Dinner Sets',
                utensils: 'Kitchen Essentials',
                storage: 'Storage Containers',
                appliances: 'Electric Kitchen Appliances',
                'stainless-steel': 'Stainless Steel',
                'air-fryers': 'Air Fryers',
                random: 'Random Products',
                misc: 'Other Brands / Miscellaneous'
            };
            return labels[category] || String(category || 'Premium Products');
        }

        function productFeatures(product) {
            const custom = Array.isArray(product.features) ? product.features.filter(Boolean) : [];
            if (custom.length) return custom;
            return [product.brand, product.category, product.low_stock ? 'Limited stock' : 'Ready stock'].filter(Boolean);
        }

        function renderCartData(cart) {
            const cartItems = document.getElementById('cartItems');
            const cartCount = document.getElementById('cartCount');
            const cartTotal = document.getElementById('cartTotal');
            if (cartCount) cartCount.textContent = cart.items.reduce((sum, item) => sum + item.quantity, 0);
            if (cartTotal) cartTotal.textContent = money(cart.total);
            if (!cartItems) return;
            if (!cart.items.length) {
                cartItems.innerHTML = '<p class="owner-note">Cart is empty. Add products to place an order.</p>';
                return;
            }
            cartItems.innerHTML = cart.items.map(item => `
      <div class="cart-item">
        <img src="${escapeHtml(assetUrl(item.image || '/assets/friends-traders-business-card.png'))}" alt="${escapeHtml(item.name)}">
        <div><h4>${escapeHtml(item.name)}</h4><p>${money(item.unit_price)}</p><div class="qty-controls"><button type="button" onclick="updateCartQty('${escapeHtml(item.product_id)}', -1)">-</button><span>${item.quantity}</span><button type="button" onclick="updateCartQty('${escapeHtml(item.product_id)}', 1)">+</button></div></div>
        <button class="remove-cart-btn" type="button" onclick="removeFromCart('${escapeHtml(item.product_id)}')" aria-label="Remove ${escapeHtml(item.name)}"><i class="fas fa-trash"></i></button>
      </div>`).join('') + `<div class="owner-note">Shipping: ${money(cart.shipping)} | Grand Total: ${money(cart.total)}</div>`;
        }

        function showCartPanel() {
            document.getElementById('cartPanel').classList.add('active');
            document.getElementById('cartPanel').setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
        }

        function productCardCountFor(filter) {
            const cards = Array.from(document.querySelectorAll('.product-card'));
            if (filter === 'all') return cards.length;
            // Use the exact same matching rule as the button click. Categories
            // such as Thermos and SK may be represented by product text/brand,
            // not only by a database slug.
            if (typeof window.productMatchesFilter === 'function') {
                return cards.filter(card => window.productMatchesFilter(card, filter)).length;
            }
            return cards.filter(card => card.getAttribute('data-category') === filter).length;
        }

        function updateCategoryCounts() {
            document.querySelectorAll('.category-card.filter-btn').forEach(button => {
                const filter = button.dataset.filter || 'all';
                const count = productCardCountFor(filter);
                const span = button.querySelector('span');
                if (span) span.textContent = count + ' ' + (count === 1 ? 'product' : 'products');
            });
        }

        function upsertProductCard(product) {
            const grid = document.querySelector('.products-grid');
            if (!grid || !product) return;
            const id = String(product.id || '');
            const title = String(product.name || '').trim().toLowerCase();
            const cards = Array.from(document.querySelectorAll('.product-card'));
            const existing = cards.find(card => String(card.dataset.id || '') === id || String(card.dataset.title || '').trim().toLowerCase() === title);
            const html = backendProductCard(product);
            if (existing) existing.outerHTML = html;
            else grid.insertAdjacentHTML('beforeend', html);
        }

        function backendProductCard(product) {
            const image = assetUrl((product.images && product.images[0] && product.images[0].url) || '/assets/friends-traders-business-card.png');
            const price = money(product.final_price);
            const oldPrice = product.discount ? money(product.price) : '';
            const availability = product.out_of_stock ? 'Out of stock' : (product.low_stock ? 'Limited stock' : 'In stock');
            const description = product.description || 'Quality product available at Friends Traders Multan.';
            return `
      <div class="product-card owner-added-product" data-category="${escapeHtml(product.category_slug)}" data-id="${escapeHtml(product.id)}" data-title="${escapeHtml(product.name)}" data-brand="${escapeHtml(product.brand)}" data-category-label="${escapeHtml(product.category)}" data-price="${escapeHtml(price)}" data-old-price="${escapeHtml(oldPrice)}" data-availability="${escapeHtml(availability)}" data-description="${escapeHtml(description)}" data-image="${escapeHtml(image)}" data-features="${productFeatures(product).map(escapeHtml).join('|')}">
        <div class="product-img">
          <img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">
          <span class="stock-badge">${escapeHtml(availability)}</span>
        </div>
        <div class="product-info">
          <div class="product-meta-row"><span class="product-category">${escapeHtml(product.category)}</span><span class="product-brand">${escapeHtml(product.brand)}</span></div>
          <h3 class="product-title">${escapeHtml(product.name)}</h3>
          <p class="product-description">${escapeHtml(description)}</p>
          <div class="product-price">${escapeHtml(price)} ${oldPrice ? '<span>' + escapeHtml(oldPrice) + '</span>' : ''}</div>
          <ul class="product-features">${productFeatures(product).slice(0,4).map(feature => '<li><i class="fas fa-check"></i> ' + escapeHtml(feature) + '</li>').join('')}<li><i class="fas fa-check"></i> Stock: ${Number(product.stock || 0)}</li></ul>
          <div class="product-actions">
            <button class="product-btn details-btn" type="button" onclick="viewProductDetails('${escapeHtml(product.id)}')"><i class="fas fa-eye"></i> View Details</button>
            <button class="product-btn whatsapp-order-btn" type="button" onclick="inquireProduct('${escapeHtml(product.name)}')"><i class="fab fa-whatsapp"></i> WhatsApp Order</button>
            <button class="product-btn add-cart-btn" type="button" ${product.out_of_stock ? 'disabled' : ''}><i class="fas fa-cart-plus"></i> Add to Cart</button>
            <button class="product-btn details-btn wishlist-btn" type="button" onclick="toggleWishlist('${escapeHtml(product.id)}', this)"><i class="far fa-heart"></i> Wishlist</button>
          </div>
        </div>
      </div>`;
        }

        async function renderBackendProducts() {
            const grid = document.querySelector('.products-grid');
            if (!grid) return;
            const data = await api('/api/products?per_page=500', { method: 'GET' });
            // The database is the single source of truth. Replacing the static
            // starter cards prevents duplicate cards and keeps category counts exact.
            grid.innerHTML = data.products.map(backendProductCard).join('');
            wireBackendCartButtons();
            updateCategoryCounts();
        }

        function wireBackendCartButtons() {
            document.querySelectorAll('.product-card').forEach(card => {
                const actions = card.querySelector('.product-actions');
                if (!actions) return;
                let button = actions.querySelector('.add-cart-btn');
                if (!button) {
                    button = document.createElement('button');
                    button.className = 'product-btn add-cart-btn';
                    button.type = 'button';
                    button.innerHTML = '<i class="fas fa-cart-plus"></i> Add to Cart';
                    actions.appendChild(button);
                }
                const fresh = button.cloneNode(true);
                fresh.addEventListener('click', event => window.addToCart(card.dataset.id, event.currentTarget));
                button.replaceWith(fresh);
            });
        }

        async function getCart() {
            return api('/api/cart', { method: 'GET' });
        }

        window.toggleWishlist = async function(productId, button) {
            const card = document.querySelector('.product-card[data-id="' + CSS.escape(productId) + '"]');
            const item = { id: productId, name: (card ? card.dataset.title : '') || 'Product', image: (card ? card.dataset.image : '') || '', price: (card ? card.dataset.price : '') || '' };
            const saved = localWishlist(),
                has = saved.some(p => p.id === productId);
            const next = has ? saved.filter(p => p.id !== productId) : [...saved, item];
            try { if (currentUser) await api('/api/wishlist/' + encodeURIComponent(productId), { method: has ? 'DELETE' : 'POST', body: '{}' }); } catch (_) {}
            saveLocalWishlist(next);
            if (button) { button.innerHTML = has ? '<i class="far fa-heart"></i> Wishlist' : '<i class="fas fa-heart"></i> Saved';
                button.classList.toggle('wishlist-saved', !has); }
            showWishlistPanel();
        };

        async function installOptionalIntegrations() {
            try {
                const config = await api('/api/public-config', { method: 'GET' });
                if (config.ga_measurement_id && /^G-[A-Z0-9]+$/i.test(config.ga_measurement_id) && !document.querySelector('[data-ft-ga]')) {
                    const s = document.createElement('script');
                    s.async = true;
                    s.dataset.ftGa = '1';
                    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(config.ga_measurement_id);
                    document.head.appendChild(s);
                    window.dataLayer = window.dataLayer || [];
                    window.gtag = window.gtag || function() { window.dataLayer.push(arguments) };
                    window.gtag('js', new Date());
                    window.gtag('config', config.ga_measurement_id);
                }
                document.documentElement.dataset.aiAssistant = config.ai_assistant_enabled ? 'enabled' : 'disabled';
            } catch (_) {}
        }

        window.showWishlistPanel = function() {
            const panel = document.getElementById('ftWishlistPanel');
            if (!panel) return;
            const items = localWishlist();
            panel.innerHTML = '<div class="ft-panel-head"><strong><i class="fas fa-heart"></i> My Wishlist</strong><button type="button" onclick="document.getElementById(\'ftWishlistPanel\').classList.remove(\'active\')">×</button></div>' + (items.length ? items.map(p => '<div class="ft-wish-item"><img src="' + escapeHtml(assetUrl(p.image || '/assets/friends-traders-business-card.png')) + '" alt=""><span>' + escapeHtml(p.name) + '</span><button type="button" onclick="addToCart(\'' + escapeHtml(p.id) + '\')"><i class="fas fa-cart-plus"></i></button></div>').join('') : '<p class="owner-note">Save products here and come back when you are ready to order.</p>');
            panel.classList.add('active');
        };

        function installStorefrontEnhancements() {
            if (document.getElementById('ftStorefrontEnhancements')) return;
            const style = document.createElement('style');
            style.id = 'ftStorefrontEnhancements';
            style.textContent = `
              .ft-store-tools{display:flex;gap:12px;align-items:center;justify-content:space-between;margin:20px 0;padding:14px;border-radius:14px;background:#fff7e9;border:1px solid #ecd4a2}.ft-search{flex:1;min-width:180px;padding:13px 16px;border:1px solid #d7b879;border-radius:9px;font:inherit}.ft-link-btn{border:0;border-radius:9px;padding:12px 14px;background:#152024;color:#fff;font-weight:700;cursor:pointer}.ft-wishlist-panel{position:fixed;z-index:2000;right:18px;bottom:78px;width:min(360px,calc(100vw - 36px));padding:18px;background:#fff;border-radius:16px;box-shadow:0 15px 50px #0004;display:none}.ft-wishlist-panel.active{display:block}.ft-panel-head{display:flex;justify-content:space-between;align-items:center;font-size:18px}.ft-panel-head button,.ft-wish-item button{border:0;background:none;font-size:22px;cursor:pointer}.ft-wish-item{display:flex;gap:10px;align-items:center;border-top:1px solid #eee;padding:10px 0}.ft-wish-item img{width:44px;height:44px;border-radius:7px;object-fit:cover}.ft-wish-item span{flex:1}.ft-mobile-nav{display:none}.ft-assistant{position:fixed;z-index:1800;right:20px;bottom:20px;border:0;border-radius:999px;padding:14px 18px;background:#15803d;color:#fff;font-weight:800;box-shadow:0 6px 20px #0004;cursor:pointer}.ft-assistant-box{position:fixed;right:20px;bottom:78px;z-index:1800;width:min(350px,calc(100vw - 40px));background:#fff;border-radius:16px;padding:16px;box-shadow:0 15px 50px #0004;display:none}.ft-assistant-box.active{display:block}.ft-assistant-close{float:right;border:0;background:none;font-size:25px;cursor:pointer}.ft-assistant-box input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #ddd;border-radius:8px;margin:10px 0}.checkout-extras{display:grid;gap:10px;margin-top:10px}.checkout-extras select,.checkout-extras input{padding:12px;border:1px solid #ddd;border-radius:8px;font:inherit}.reviews-container{flex-wrap:nowrap!important}@media(max-width:700px){.ft-store-tools{position:sticky;top:65px;z-index:20;flex-wrap:wrap}.ft-mobile-nav{display:flex;position:fixed;z-index:1700;bottom:0;left:0;right:0;justify-content:space-around;padding:9px;background:#152024;color:#fff}.ft-mobile-nav button{background:none;border:0;color:#fff;font:inherit}.ft-assistant{bottom:66px}.ft-wishlist-panel{bottom:66px}}`;
            document.head.appendChild(style);
            const grid = document.querySelector('.products-grid');
            if (grid) { const tools = document.createElement('div');
                tools.className = 'ft-store-tools';
                tools.innerHTML = '<input id="ftProductSearch" class="ft-search" placeholder="🔍 Search products, brands or categories"><button class="ft-link-btn" type="button" onclick="showWishlistPanel()">♡ My Wishlist</button>';
                grid.parentElement.insertBefore(tools, grid);
                document.getElementById('ftProductSearch').addEventListener('input', e => { const q = e.target.value.toLowerCase();
                    document.querySelectorAll('.product-card').forEach(c => c.style.display = (c.dataset.title + ' ' + c.dataset.brand + ' ' + c.dataset.categoryLabel).toLowerCase().includes(q) ? '' : 'none'); }); }
            document.body.insertAdjacentHTML('beforeend', '<aside id="ftWishlistPanel" class="ft-wishlist-panel" aria-live="polite"></aside><button class="ft-assistant" type="button" onclick="document.getElementById(\'ftAssistantBox\').classList.toggle(\'active\')">🤖 Ask FT</button><section id="ftAssistantBox" class="ft-assistant-box"><button class="ft-assistant-close" type="button" aria-label="Close assistant" onclick="document.getElementById(\'ftAssistantBox\').classList.remove(\'active\')">×</button><strong>Friends Traders Assistant</strong><p>Tell us your budget or product need.</p><input id="ftAssistantQuestion" placeholder="e.g. Gift set under 10,000"><button class="ft-link-btn" type="button" onclick="ftAskAssistant()">Find products</button><div id="ftAssistantAnswer" class="owner-note"></div></section><nav class="ft-mobile-nav"><button onclick="window.scrollTo({top:0,behavior:\'smooth\'})">⌂ Home</button><button onclick="var p=document.querySelector(\'.products-grid\');if(p){p.scrollIntoView({behavior:\'smooth\'})}">Shop</button><button onclick="showWishlistPanel()">♡ Saved</button><button onclick="openCart()">🛒 Cart</button></nav>');
            const checkout = document.querySelector('.checkout-form');
            if (checkout && !document.getElementById('checkoutPayment')) { const extras = document.createElement('div');
                extras.className = 'checkout-extras';
                extras.innerHTML = '<input id="customerEmail" type="email" placeholder="Email (optional)"><select id="checkoutPayment"><option value="cod">Cash on Delivery</option><option value="bank_transfer">Bank Transfer</option><option value="easypaisa">Easypaisa / JazzCash</option></select><input id="checkoutCoupon" placeholder="Coupon code (e.g. WELCOME5)"><small>Free delivery in Multan on orders above PKR 10,000.</small>';
                checkout.appendChild(extras); }
        }

        window.ftAskAssistant = async function() { var question = document.getElementById('ftAssistantQuestion'); var answer = document.getElementById('ftAssistantAnswer'); var q = (question ? question.value : '').trim(); if (!q) { answer.textContent = 'Please write your question first.'; return; }
            answer.textContent = 'Finding the best answer...'; try { var data = await api('/api/assistant', { method: 'POST', body: JSON.stringify({ question: q }) });
                answer.textContent = data.answer || 'Please contact WhatsApp 03007195451 for help.'; } catch (_) { var term = q.toLowerCase().split(/\s+/).find(function(word) { return word.length > 2; }) || ''; var matches = Array.from(document.querySelectorAll('.product-card')).filter(function(card) { return (card.dataset.title + ' ' + card.dataset.description + ' ' + card.dataset.categoryLabel).toLowerCase().includes(term); }).slice(0, 3);
                answer.textContent = matches.length ? 'Available options: ' + matches.map(function(card) { return card.dataset.title; }).join(', ') + '. For ordering, WhatsApp 03007195451.' : 'Tell me your budget or product type. You can also contact WhatsApp 03007195451.'; } };

        async function renderBackendCart() {
            renderCartData(cacheCart(await getCart()));
        }

        function optimisticCartItem(productId) {
            const card = document.querySelector(`.product-card[data-id="${CSS.escape(productId)}"]`);
            if (!card) return null;
            const rawPrice = String(card.dataset.price || '0').replace(/[^0-9.]/g, '');
            return {
                product_id: productId,
                name: card.dataset.title || 'Product',
                image: card.dataset.image || '',
                quantity: 1,
                unit_price: Number(rawPrice || 0),
                line_total: Number(rawPrice || 0)
            };
        }

        function addToCachedCart(productId) {
            const cart = cachedCart() || { items: [], subtotal: 0, shipping: 0, total: 0 };
            const existing = cart.items.find(item => item.product_id === productId);
            if (existing) existing.quantity += 1;
            else {
                const item = optimisticCartItem(productId);
                if (!item) return null;
                cart.items.push(item);
            }
            cart.subtotal = cart.items.reduce((sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 0), 0);
            cart.shipping = cart.subtotal >= 10000 || cart.subtotal === 0 ? 0 : 300;
            cart.total = cart.subtotal + cart.shipping;
            cart.items.forEach(item => item.line_total = Number(item.unit_price || 0) * Number(item.quantity || 0));
            return cacheCart(cart);
        }

        window.addToCart = async function(productId, button) {
            const btn = button || null;
            const oldHtml = btn ? btn.innerHTML : '';
            const cartItems = document.getElementById('cartItems');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';
            }
            showCartPanel();
            const optimistic = addToCachedCart(productId);
            if (optimistic) renderCartData(optimistic);
            else if (cartItems) cartItems.innerHTML = '<p class="owner-note">Adding product...</p>';
            try {
                const cart = await api('/api/cart/items', { method: 'POST', body: JSON.stringify({ product_id: productId, quantity: 1 }), timeoutMs: 60000 });
                renderCartData(cacheCart(cart));
            } catch (error) {
                if (optimistic && cartItems) cartItems.insertAdjacentHTML('beforeend', '<p class="owner-note">Cart is shown instantly. It will sync when the server is available.</p>');
                else if (cartItems) cartItems.innerHTML = '<p class="owner-note">Could not add product. Please try again.</p>';
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = oldHtml || '<i class="fas fa-cart-plus"></i> Add to Cart';
                }
            }
        };

        window.updateCartQty = async function(productId, delta) {
            const cart = cachedCart() || await getCart();
            const item = cart.items.find(row => row.product_id === productId);
            const quantity = Math.max(0, (item ? item.quantity : 0) + delta);
            if (item) { item.quantity = quantity;
                cart.items = cart.items.filter(row => row.quantity > 0);
                cart.subtotal = cart.items.reduce((sum, row) => sum + Number(row.unit_price || 0) * Number(row.quantity || 0), 0);
                cart.shipping = cart.subtotal >= 10000 || cart.subtotal === 0 ? 0 : 300;
                cart.total = cart.subtotal + cart.shipping;
                renderCartData(cacheCart(cart)); }
            try { const fresh = await api('/api/cart/items/' + encodeURIComponent(productId), { method: 'PATCH', body: JSON.stringify({ quantity: quantity }) });
                renderCartData(cacheCart(fresh)); } catch (_) { renderCartData(cart); }
        };

        window.removeFromCart = async function(productId) {
            await api('/api/cart/items/' + encodeURIComponent(productId), { method: 'PATCH', body: JSON.stringify({ quantity: 0 }) });
            await renderBackendCart();
        };

        window.openCart = async function() {
            const cartItems = document.getElementById('cartItems');
            showCartPanel();
            const cached = cachedCart();
            if (cached) renderCartData(cached);
            else if (cartItems) cartItems.innerHTML = '<p class="owner-note">Loading cart...</p>';
            try {
                await renderBackendCart();
                if (currentUser) await renderCustomerOrderStatus();
                else await renderCustomerOrderStatus();
            } catch (error) {
                if (cartItems) cartItems.innerHTML = '<p class="owner-note">Cart load nahi ho saka. Please try again.</p>';
            }
        };

        async function renderCustomerOrderStatus() {
            const box = document.getElementById('customerOrderStatus');
            if (!box) return;
            if (!currentUser) {
                box.innerHTML = '<p class="owner-note">Guest orders owner panel me save hotay hain. Login users apni history yahan dekh sakte hain.</p>';
                return;
            }
            try {
                const data = await api('/api/orders', { method: 'GET' });
                if (!data.orders.length) { box.innerHTML = '<p class="owner-note">No order placed yet.</p>'; return; }
                box.innerHTML = '<h4>My Order Status</h4>' + data.orders.map(order => `<div class="order-status-card"><h4>${escapeHtml(order.id)}</h4><p>${escapeHtml(order.customer_name)} | ${escapeHtml(order.phone)}</p><p>${order.items.length} items | ${money(order.total)}</p><span class="status-badge ${statusClass(order.order_status)}">${escapeHtml(order.order_status)}</span></div>`).join('');
            } catch (_) {
                box.innerHTML = '<p class="owner-note">Login to view saved order history. Guest orders still appear in owner panel.</p>';
            }
        }

        window.placeOrder = async function() {
            const customerName = document.getElementById('customerName').value.trim();
            const customerPhone = document.getElementById('customerPhone').value.trim();
            const customerAddress = document.getElementById('customerAddress').value.trim();
            const emailField = document.getElementById('customerEmail');
            const paymentField = document.getElementById('checkoutPayment');
            const couponField = document.getElementById('checkoutCoupon');
            const customerEmail = emailField ? emailField.value.trim() : '';
            const paymentMethod = paymentField ? paymentField.value : 'cod';
            const couponCode = couponField ? couponField.value.trim() : '';
            if (!customerName || !customerPhone || !customerAddress) { alert('Name, mobile number and complete address are compulsory.'); return; }
            if (!customerAddress.toLowerCase().includes('multan')) { alert('Abhi delivery sirf Multan ke liye available hai. Address me Multan zaroor likhein.'); return; }
            try {
                const data = await api('/api/checkout', { method: 'POST', body: JSON.stringify({ customer: { name: customerName, phone: customerPhone, email: customerEmail, address: customerAddress }, payment_method: paymentMethod, coupon_code: couponCode }) });
                document.getElementById('customerName').value = '';
                document.getElementById('customerPhone').value = '';
                document.getElementById('customerAddress').value = '';
                alert('Order saved permanently: ' + data.order.id + '. Owner panel me lazmi show ho ga.');
                const lines = data.order.items.map(item => item.name + ' x ' + item.quantity + ' = PKR ' + item.line_total).join('\n');
                const message = 'Assalam o Alaikum Friends Traders, new website order ' + data.order.id + '%0A%0A' + encodeURIComponent(lines) + '%0A%0ATotal: PKR ' + data.order.total + '%0AName: ' + encodeURIComponent(data.order.customer_name) + '%0APhone: ' + encodeURIComponent(data.order.phone) + '%0AAddress: ' + encodeURIComponent(data.order.address);
                window.open('https://wa.me/923007195451?text=' + message, '_blank');
                await renderBackendCart();
                await renderCustomerOrderStatus();
                if (ownerMode) await renderOwnerDashboard();
            } catch (error) { alert(error.message); }
        };
        window.checkoutCart = window.placeOrder;

        function ensureOwnerExtras() {
            const tools = document.getElementById('ownerTools');
            if (!tools || document.getElementById('ownerExtraFields')) return;
            const div = document.createElement('div');
            div.id = 'ownerExtraFields';
            div.className = 'owner-tools';
            div.innerHTML = `
      <input id="ownerProductSku" type="text" placeholder="SKU / product code">
      <input id="ownerProductBrand" type="text" placeholder="Brand">
      <input id="ownerProductDiscount" type="number" min="0" step="1" placeholder="Discount amount">
      <input id="ownerProductStock" type="number" min="0" step="1" placeholder="Stock quantity">
      <select id="ownerProductStatus"><option value="active">Active</option><option value="hidden">Hidden</option><option value="draft">Draft</option></select>
      <textarea id="ownerProductFeatures" placeholder="Characteristics/features: one per line, e.g. Stainless steel body"></textarea>
      <input id="ownerProductImages" type="file" accept="image/*" multiple>
      <input id="ownerEditingProductId" type="hidden">
      <div class="owner-note">Render par permanent images ke liye Image URL best hai. Supabase database mode mein small uploads bhi store ho jati hain.</div>
      <div id="ownerProductManager" class="order-status-list"></div>
      <div class="owner-note">Exports and backup</div>
      <a class="btn btn-secondary" href="${apiUrl('/api/export/products.csv')}">Products CSV</a>
      <a class="btn btn-secondary" href="${apiUrl('/api/export/orders.csv')}">Orders CSV</a>
      <a class="btn btn-secondary" href="${apiUrl('/api/export/orders.pdf')}">Orders PDF</a>
      <button class="btn btn-primary" type="button" onclick="createBackup()"><i class="fas fa-download"></i> Backup Database</button>
      <textarea id="restorePayload" placeholder="Paste backup JSON to restore"></textarea>
      <button class="btn btn-secondary" type="button" onclick="restoreBackup()"><i class="fas fa-upload"></i> Restore Backup</button>`;
            tools.appendChild(div);
            const clearBtn = Array.from(tools.querySelectorAll('button')).find(btn => /Clear Added Products/i.test(btn.textContent));
            if (clearBtn) clearBtn.style.display = 'none';
        }

        window.openOwnerPanel = async function() {
            document.getElementById('ownerPanel').classList.add('active');
            document.getElementById('ownerPanel').setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
            if (ownerMode) await renderOwnerDashboard();
        };

        window.closeOwnerPanel = function() {
            document.getElementById('ownerPanel').classList.remove('active');
            document.getElementById('ownerPanel').setAttribute('aria-hidden', 'true');
            document.body.style.overflow = '';
        };

        window.unlockOwnerPanel = async function() {
            const typed = document.getElementById('ownerPassword').value;
            const loginButton = document.querySelector('#ownerLogin .btn-primary');
            const oldText = loginButton ? loginButton.innerHTML : '';
            if (loginButton) {
                loginButton.disabled = true;
                loginButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening...';
            }
            try {
                const loginData = await api('/api/auth/owner-login', { method: 'POST', body: JSON.stringify({ password: typed }) });
                currentUser = loginData.user || currentUser;
                ownerMode = true;
                document.getElementById('ownerLogin').style.display = 'none';
                document.getElementById('ownerTools').style.display = 'grid';
                ensureOwnerExtras();
                await renderOwnerDashboard();
                if (!ownerRefreshTimer) ownerRefreshTimer = setInterval(() => { if (ownerMode) renderOwnerDashboard().catch(() => {}); }, 8000);
            } catch (error) {
                alert(error.message + ' Please check OWNER_PASSWORD in Render Environment.');
            } finally {
                if (loginButton && !ownerMode) {
                    loginButton.disabled = false;
                    loginButton.innerHTML = oldText;
                }
            }
        };

        async function renderOwnerDashboard() {
            const data = await api('/api/owner/summary', { method: 'GET' });
            const statsBox = document.getElementById('ownerOrderStats');
            const listBox = document.getElementById('ownerOrdersList');
            const manager = document.getElementById('ownerProductManager');
            const cards = data.cards || {};
            if (statsBox) {
                statsBox.innerHTML = [
                    ['Products', cards.total_products],
                    ['Orders', cards.total_orders],
                    ['Pending', cards.pending_orders],
                    ['Processing', cards.processing_orders],
                    ['Completed', cards.completed_orders],
                    ['Cancelled', cards.cancelled_orders],
                    ['Revenue', money(cards.revenue)],
                    ['Today', money(cards.today_sales)],
                    ['Month', money(cards.monthly_sales)]
                ].map(([label, value]) => `<div class="order-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('');
            }
            if (listBox) {
                listBox.innerHTML = '<h4>All Orders</h4>' + (data.orders.length ? data.orders.map(order => `
        <div class="owner-order">
          <strong>${escapeHtml(order.id)} - ${money(order.total)}</strong>
          <span>${escapeHtml(order.customer_name)} | ${escapeHtml(order.phone)} | ${escapeHtml(order.payment_method)}</span>
          <span>${escapeHtml(order.address)}</span>
          <span>${order.items.map(item => escapeHtml(item.name + ' x ' + item.quantity)).join(', ')}</span>
          <select onchange="updateOrderStatus('${escapeHtml(order.id)}', this.value)">${['pending','processing','completed','cancelled'].map(status => `<option value="${status}" ${order.order_status === status ? 'selected' : ''}>${status}</option>`).join('')}</select>
          <a class="btn btn-secondary" target="_blank" href="${apiUrl('/api/orders/' + encodeURIComponent(order.id) + '/invoice')}">Print Invoice</a>
        </div>`).join('') : '<p class="owner-note">No order yet.</p>') +
        '<h4>Low Stock</h4>' + (data.low_stock.length ? data.low_stock.map(p => `<div class="owner-order"><strong>${escapeHtml(p.name)}</strong><span>Stock: ${Number(p.stock || 0)}</span></div>`).join('') : '<p class="owner-note">No low stock products.</p>') +
        '<h4>Notifications</h4>' + (data.notifications.length ? data.notifications.map(n => `<div class="order-status-card">${escapeHtml(n.message)}</div>`).join('') : '<p class="owner-note">No new notifications.</p>');
    }
    if (manager) {
      manager.innerHTML = '<h4>Products In Database</h4>' + (data.products.length ? data.products.map(product => `
        <div class="owner-order">
          <strong>${escapeHtml(product.name)}</strong>
          <span>${escapeHtml(product.sku)} | ${escapeHtml(product.brand)} | ${money(product.final_price)} | ${escapeHtml(product.status)}</span>
          <span>Features: ${productFeatures(product).map(escapeHtml).join(', ') || 'Not added'}</span>
          <input type="number" min="0" step="1" value="${Number(product.stock || 0)}" aria-label="Stock for ${escapeHtml(product.name)}" data-stock-for="${escapeHtml(product.id)}">
          <select data-status-for="${escapeHtml(product.id)}">${['active','hidden','draft'].map(status => `<option value="${status}" ${product.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select>
          <button class="btn btn-secondary" type="button" onclick="editOwnerProduct('${escapeHtml(product.id)}')"><i class="fas fa-edit"></i> Edit Full Product</button>
          <button class="btn btn-secondary" type="button" onclick="updateProductQuick('${escapeHtml(product.id)}')"><i class="fas fa-save"></i> Save Stock/Status</button>
          <button class="btn btn-primary" type="button" onclick="deleteOwnerProduct('${escapeHtml(product.id)}')"><i class="fas fa-trash"></i> Delete Product</button>
        </div>`).join('') : '<p class="owner-note">No products in database.</p>');
    }
  }

  window.updateOrderStatus = async function(orderId, status) {
    await api('/api/orders/' + encodeURIComponent(orderId), { method: 'PATCH', body: JSON.stringify({ order_status: status }) });
    await renderOwnerDashboard();
  };

  window.editOwnerProduct = async function(productId) {
    const data = await api('/api/products/' + encodeURIComponent(productId), { method: 'GET' });
    const p = data.product;
    editingProductId = p.id;
    document.getElementById('ownerEditingProductId').value = p.id;
    document.getElementById('ownerProductTitle').value = p.name || '';
    document.getElementById('ownerProductPrice').value = p.price || '';
    document.getElementById('ownerProductImage').value = (p.images && p.images[0] && !String(p.images[0].url).startsWith('data:')) ? p.images[0].url : '';
    document.getElementById('ownerProductCategory').value = p.category_slug || 'misc';
    document.getElementById('ownerProductDescription').value = p.description || '';
    document.getElementById('ownerProductSku').value = p.sku || '';
    document.getElementById('ownerProductBrand').value = p.brand || '';
    document.getElementById('ownerProductDiscount').value = p.discount || 0;
    document.getElementById('ownerProductStock').value = p.stock || 0;
    document.getElementById('ownerProductStatus').value = p.status || 'active';
    document.getElementById('ownerProductFeatures').value = productFeatures(p).join('\n');
    document.getElementById('ownerProductTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  window.updateProductQuick = async function(productId) {
    const stock = document.querySelector(`[data-stock-for="${CSS.escape(productId)}"]`)?.value || 0;
    const status = document.querySelector(`[data-status-for="${CSS.escape(productId)}"]`)?.value || 'active';
    await api('/api/products/' + encodeURIComponent(productId), { method: 'PATCH', body: JSON.stringify({ stock, status }) });
    await renderBackendProducts();
    await renderOwnerDashboard();
  };

  window.deleteOwnerProduct = async function(productId) {
    if (!confirm('Delete this product permanently?')) return;
    await api('/api/products/' + encodeURIComponent(productId), { method: 'DELETE', body: '{}' });
    document.querySelectorAll(`.product-card[data-id="${CSS.escape(productId)}"]`).forEach(card => card.remove());
    await renderOwnerDashboard();
  };

  window.saveOwnerProduct = async function() {
    if (productSaveInProgress) return;
    const title = document.getElementById('ownerProductTitle').value.trim();
    const rawPrice = document.getElementById('ownerProductPrice').value.trim().replace(/[^0-9.]/g, '');
    if (!title || !rawPrice) { alert('Product name aur price zaroori hain.'); return; }
    const category = document.getElementById('ownerProductCategory');
    const form = new FormData();
    form.append('sku', document.getElementById('ownerProductSku')?.value.trim() || slugify(title).toUpperCase().replace(/-/g, '_'));
    form.append('name', title);
    form.append('price', rawPrice);
    form.append('image_url', document.getElementById('ownerProductImage').value.trim());
    form.append('category_slug', category.value);
    form.append('category', category.selectedOptions[0].textContent);
    form.append('brand', document.getElementById('ownerProductBrand')?.value.trim() || 'Friends Traders');
    form.append('description', document.getElementById('ownerProductDescription').value.trim());
    form.append('features', document.getElementById('ownerProductFeatures')?.value.trim() || '');
    form.append('discount', document.getElementById('ownerProductDiscount')?.value || 0);
    form.append('stock', document.getElementById('ownerProductStock')?.value || 10);
    form.append('status', document.getElementById('ownerProductStatus')?.value || 'active');
    Array.from(document.getElementById('ownerProductImages')?.files || []).forEach(file => form.append('images', file));
    productSaveInProgress = true;
    const saveButton = document.querySelector('#ownerTools button[onclick="saveOwnerProduct()"]');
    const originalSaveButton = saveButton?.innerHTML;
    if (saveButton) { saveButton.disabled = true; saveButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }
    try {
      const editId = editingProductId || document.getElementById('ownerEditingProductId')?.value;
      const response = await fetch(apiUrl(editId ? '/api/products/' + encodeURIComponent(editId) : '/api/products'), { method: editId ? 'PUT' : 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken }, body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not save product');
      ['ownerProductTitle','ownerProductPrice','ownerProductImage','ownerProductDescription','ownerProductSku','ownerProductBrand','ownerProductDiscount','ownerProductStock','ownerProductFeatures','ownerEditingProductId'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      editingProductId = null;
      const files = document.getElementById('ownerProductImages'); if (files) files.value = '';
      alert(editId ? 'Product updated.' : 'Product saved permanently and website grid me show ho ga.');
      if (data.product) upsertProductCard(data.product);
      wireBackendCartButtons();
      updateCategoryCounts();
      await renderOwnerDashboard();
    } catch (error) { alert(error.message); }
    finally {
      productSaveInProgress = false;
      if (saveButton) { saveButton.disabled = false; saveButton.innerHTML = originalSaveButton; }
    }
  };

  window.clearOwnerProducts = function() {
    alert('Products database me permanently save hoti hain. Delete karne ke liye Products In Database section ka Delete button use karein.');
  };

  window.createBackup = async function() {
    const data = await api('/api/backup', { method: 'POST', body: '{}' });
    const target = document.getElementById('restorePayload');
    if (target) target.value = JSON.stringify(data.backup, null, 2);
    alert('Backup created: ' + data.path);
  };

  window.restoreBackup = async function() {
    await api('/api/restore', { method: 'POST', body: document.getElementById('restorePayload').value || '{}' });
    alert('Backup restored.');
    await renderOwnerDashboard();
  };

  function reviewCard(review) {
    const name = escapeHtml(review.name || 'Customer');
    const initials = name.split(/\s+/).map(part => part[0]).join('').slice(0,2).toUpperCase() || 'FT';
    const rating = Math.max(1, Math.min(5, Number(review.rating || 5)));
    return `<div class="review-card"><div class="review-header"><div class="review-avatar">${initials}</div><div class="review-info"><h4>${name}</h4><div class="review-rating">${'<i class="fas fa-star"></i>'.repeat(rating)}</div><div class="review-date">Customer Review</div></div></div><div class="review-content">"${escapeHtml(review.message || '')}"</div></div>`;
  }

  function ensureReviewForm() {
    const reviewsSection = document.getElementById('reviews');
    const container = document.getElementById('reviewsContainer');
    if (!reviewsSection || !container || document.getElementById('customerReviewForm')) return;
    const form = document.createElement('div');
    form.className = 'review-form';
    form.id = 'customerReviewForm';
    form.innerHTML = `<h3>Share Your Review</h3><div class="review-form-grid"><input id="reviewName" type="text" placeholder="Your name"><input id="reviewPhone" type="tel" placeholder="Phone optional"><select id="reviewRating"><option value="5">5 Stars</option><option value="4">4 Stars</option><option value="3">3 Stars</option><option value="2">2 Stars</option><option value="1">1 Star</option></select></div><textarea id="reviewMessage" placeholder="Write your review"></textarea><button class="btn btn-secondary" type="button" onclick="submitCustomerReview()"><i class="fas fa-star"></i> Submit Review</button>`;
    container.parentElement.insertAdjacentElement('afterend', form);
  }

  async function loadCustomerReviews() {
    const container = document.getElementById('reviewsContainer');
    if (!container) return;
    try {
      const data = await api('/api/reviews', { method: 'GET' });
      if (data.reviews && data.reviews.length) {
        container.insertAdjacentHTML('afterbegin', data.reviews.map(reviewCard).join(''));
      }
    } catch (_) {}
  }

  window.submitCustomerReview = async function() {
    const name = document.getElementById('reviewName')?.value.trim();
    const phone = document.getElementById('reviewPhone')?.value.trim();
    const rating = document.getElementById('reviewRating')?.value || 5;
    const message = document.getElementById('reviewMessage')?.value.trim();
    if (!name || !message) { alert('Name aur review message zaroori hain.'); return; }
    try {
      const data = await api('/api/reviews', { method: 'POST', body: JSON.stringify({ name, phone, rating, message }) });
      document.getElementById('reviewsContainer')?.insertAdjacentHTML('afterbegin', reviewCard(data.review));
      ['reviewName','reviewPhone','reviewMessage'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      alert('Review added. Thank you.');
    } catch (error) { alert(error.message || 'Review save nahi ho saka.'); }
  };

  document.addEventListener('DOMContentLoaded', async () => {
    // Keep the visible page usable immediately. Reviews and category counts
    // must not wait for the products request (which can be slow on a cold server).
    ensureReviewForm();
    // Two original review cards were accidentally placed outside the slider.
    // Move only those stray cards into the existing slider; do not alter its layout.
    const reviewTrack=document.getElementById('reviewsContainer');
    const reviewSection=document.getElementById('reviews');
    if (reviewTrack && reviewSection) {
      Array.from(reviewSection.querySelectorAll(':scope > .container > .review-card, :scope > .container > .reviews-slider > .review-card')).forEach(card => reviewTrack.appendChild(card));
    }
    installStorefrontEnhancements();
    document.addEventListener('click', function(event) {
      const details=event.target.closest('.details-btn');
      if (!details) return;
      const card=details.closest('.product-card');
      if (!card) return;
      setTimeout(function() {
        const productId=card.dataset.id, productName=card.dataset.title || 'Product';
        const add=document.getElementById('detailAddCartBtn');
        const order=document.getElementById('detailOrderBtn');
        if (add) add.onclick=function(){ window.addToCart(productId,add); };
        if (order) order.onclick=function(){ window.addToCart(productId); window.inquireProduct(productName); };
      },0);
    });
    updateCategoryCounts();
    const cached = cachedCart();
    if (cached) renderCartData(cached);
    try {
      await initCsrf();
      await Promise.allSettled([renderBackendProducts(), loadCustomerReviews()]);
      renderBackendCart().catch(() => {});
      installOptionalIntegrations();
    } catch (error) {
      console.warn('Backend ecommerce unavailable:', error.message);
    }
  });
})();
