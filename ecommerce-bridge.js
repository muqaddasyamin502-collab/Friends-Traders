(function() {
        let csrfToken = '';
        let ownerMode = false;
        const backendHost = location.hostname === 'localhost' ? 'localhost' : '127.0.0.1';
        const apiBase = (location.protocol === 'file:' || !['5001', ''].includes(location.port)) ? `http://${backendHost}:5001` : '';
        const apiUrl = url => apiBase + url;
        const assetUrl = url => (url && url.startsWith('/')) ? apiBase + url : url;
        const money = value => 'PKR ' + Number(value || 0).toLocaleString('en-PK');
        const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
        const api = async(url, options = {}, retry = true) => {
            const headers = options.body instanceof FormData ? { 'X-CSRF-Token': csrfToken } : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
            const response = await fetch(apiUrl(url), { credentials: 'include', ...options, headers: {...headers, ...(options.headers || {}) } });
            const data = await response.json().catch(() => ({}));
            if (response.status === 403 && retry && String(data.error || '').toLowerCase().includes('security token')) {
                await initCsrf();
                return api(url, options, false);
            }
            if (!response.ok) throw new Error(data.error || 'Request failed');
            return data;
        };
        const statusClass = status => 'status-' + String(status || 'pending').toLowerCase();
        async function initCsrf() {
            const data = await fetch(apiUrl('/api/csrf'), { credentials: 'include' }).then(r => r.json());
            csrfToken = data.csrf_token;
        }
        async function getCart() { return api('/api/cart', { method: 'GET' }); }
        window.addToCart = async function(productId) {
            try { await api('/api/cart/items', { method: 'POST', body: JSON.stringify({ product_id: productId, quantity: 1 }) });
                await window.openCart(); } catch (error) { alert(error.message); }
        };
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
                fresh.addEventListener('click', () => window.addToCart(card.dataset.id));
                button.replaceWith(fresh);
            });
        }
        window.updateCartQty = async function(productId, delta) {
            const cart = await getCart();
            const item = cart.items.find(i => i.product_id === productId);
            await api('/api/cart/items/' + encodeURIComponent(productId), { method: 'PATCH', body: JSON.stringify({ quantity: Math.max(0, (item ? item.quantity : 0) + delta) }) });
            await renderBackendCart();
        };
        window.removeFromCart = async function(productId) {
            await api('/api/cart/items/' + encodeURIComponent(productId), { method: 'PATCH', body: JSON.stringify({ quantity: 0 }) });
            await renderBackendCart();
        };
        async function renderBackendCart() {
            const cart = await getCart();
            const cartItems = document.getElementById('cartItems');
            const cartCount = document.getElementById('cartCount');
            const cartTotal = document.getElementById('cartTotal');
            cartCount.textContent = cart.items.reduce((sum, item) => sum + item.quantity, 0);
            cartTotal.textContent = money(cart.total);
            if (!cart.items.length) {
                cartItems.innerHTML = '<p class="owner-note">Cart is empty.Add products.</p>';
                return;
            }
            cartItems.innerHTML = cart.items.map(item => `
      <div class="cart-item">
        <img src="${assetUrl(item.image || '/assets/friends-traders-business-card.png')}" alt="${item.name}">
        <div>
          <h4>${item.name}</h4>
          <p>${money(item.unit_price)}</p>
          <div class="qty-controls">
            <button type="button" onclick="updateCartQty('${item.product_id}', -1)">-</button>
            <span>${item.quantity}</span>
            <button type="button" onclick="updateCartQty('${item.product_id}', 1)">+</button>
          </div>
        </div>
        <button class="remove-cart-btn" type="button" onclick="removeFromCart('${item.product_id}')" aria-label="Remove ${item.name}"><i class="fas fa-trash"></i></button>
      </div>`).join('') + `<div class="owner-note">Shipping: ${money(cart.shipping)} | Grand Total: ${money(cart.total)}</div>`;
        }
        async function renderCustomerOrderStatus() {
            const box = document.getElementById('customerOrderStatus');
            if (!box) return;
            try {
                const data = await api('/api/orders', { method: 'GET' });
                if (!data.orders.length) { box.innerHTML = '<p class="owner-note">No order placed yet.</p>'; return; }
                box.innerHTML = '<h4>My Order Status</h4>' + data.orders.map(order => `
        <div class="order-status-card">
          <h4>${order.id}</h4>
          <p>${order.customer_name} | ${order.phone}</p>
          <p>${order.items.length} items | ${money(order.total)}</p>
          <span class="status-badge ${statusClass(order.order_status)}">${order.order_status}</span>
        </div>`).join('');
            } catch (_) { box.innerHTML = '<p class="owner-note">Login to view order history.</p>'; }
        }
        window.openCart = async function() {
            await renderBackendCart();
            await renderCustomerOrderStatus();
            document.getElementById('cartPanel').classList.add('active');
            document.getElementById('cartPanel').setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
        };
        window.placeOrder = async function() {
            const customerName = document.getElementById('customerName').value.trim();
            const customerPhone = document.getElementById('customerPhone').value.trim();
            const customerAddress = document.getElementById('customerAddress').value.trim();
            if (!customerName || !customerPhone || !customerAddress) { alert('Name , Mobile Number and real address is compulsory'); return; }
            if (!customerAddress.toLowerCase().includes('multan')) { alert('Abhi delivery sirf Multan ke liye available hai. Address me Multan zaroor likhein.'); return; }
            try {
                const data = await api('/api/checkout', { method: 'POST', body: JSON.stringify({ customer: { name: customerName, phone: customerPhone, address: customerAddress }, payment_method: 'cod' }) });
                document.getElementById('customerName').value = '';
                document.getElementById('customerPhone').value = '';
                document.getElementById('customerAddress').value = '';
                alert('Order saved permanently: ' + data.order.id + '. Owner panel me show ho ga.');
                await renderBackendCart();
                await renderCustomerOrderStatus();
                if (ownerMode) await renderOwnerDashboard();
            } catch (error) { alert(error.message); }
        };
        window.checkoutCart = window.placeOrder;

        function backendProductCard(product) {
            const image = assetUrl((product.images && product.images[0] && product.images[0].url) || '/assets/friends-traders-business-card.png');
            const price = money(product.final_price);
            const oldPrice = product.discount ? money(product.price) : '';
            const description = product.description || 'Quality product available at Friends Traders Multan.';
            const availability = product.out_of_stock ? 'Out of stock' : (product.low_stock ? 'Limited stock' : 'In stock');
            return `
      <div class="product-card owner-added-product" data-category="${escapeHtml(product.category_slug)}" data-id="${escapeHtml(product.id)}" data-title="${escapeHtml(product.name)}" data-brand="${escapeHtml(product.brand)}" data-category-label="${escapeHtml(product.category)}" data-price="${escapeHtml(price)}" data-old-price="${escapeHtml(oldPrice)}" data-availability="${escapeHtml(availability)}" data-description="${escapeHtml(description)}" data-image="${escapeHtml(image)}" data-features="Database Product|Available at Friends Traders|Multan delivery">
        <div class="product-img">
          <img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">
          <span class="stock-badge">${escapeHtml(availability)}</span>
        </div>
        <div class="product-info">
          <div class="product-meta-row">
            <span class="product-category">${escapeHtml(product.category)}</span>
            <span class="product-brand">${escapeHtml(product.brand)}</span>
          </div>
          <h3 class="product-title">${escapeHtml(product.name)}</h3>
          <p class="product-description">${escapeHtml(description)}</p>
          <div class="product-price">${escapeHtml(price)} ${oldPrice ? '<span>' + escapeHtml(oldPrice) + '</span>' : ''}</div>
          <ul class="product-features">
            <li><i class="fas fa-check"></i> Database Product</li>
            <li><i class="fas fa-check"></i> Available at Friends Traders Multan</li>
            <li><i class="fas fa-check"></i> Stock: ${Number(product.stock || 0)}</li>
          </ul>
          <div class="product-actions">
            <button class="product-btn details-btn" type="button" onclick="viewProductDetails('${escapeHtml(product.id)}')"><i class="fas fa-eye"></i> View Details</button>
            <button class="product-btn whatsapp-order-btn" type="button" onclick="inquireProduct('${escapeHtml(product.name)}')"><i class="fab fa-whatsapp"></i> WhatsApp Order</button>
            <button class="product-btn add-cart-btn" type="button" onclick="window.addToCart('${escapeHtml(product.id)}')"><i class="fas fa-cart-plus"></i> Add to Cart</button>
          </div>
        </div>
      </div>`;
        }

        async function renderBackendProducts() {
            const grid = document.querySelector('.products-grid');
            if (!grid) return;
            try {
                const data = await api('/api/products?per_page=200', { method: 'GET' });
                const existingTitles = new Set(Array.from(document.querySelectorAll('.product-card')).map(card => String(card.dataset.title || '').trim().toLowerCase()));
                const fresh = data.products.filter(product => !existingTitles.has(String(product.name || '').trim().toLowerCase()));
                if (fresh.length) grid.insertAdjacentHTML('beforeend', fresh.map(backendProductCard).join(''));
                wireBackendCartButtons();
            } catch (error) {
                console.warn('Backend products could not load:', error.message);
            }
        }

        function enhanceOwnerFields() {
            const tools = document.getElementById('ownerTools');
            if (!tools || document.getElementById('ownerExtraFields')) return;
            const div = document.createElement('div');
            div.id = 'ownerExtraFields';
            div.className = 'owner-tools';
            div.innerHTML = `
      <input id="ownerProductSku" type="text" placeholder="SKU">
      <input id="ownerProductBrand" type="text" placeholder="Brand">
      <input id="ownerProductDiscount" type="number" placeholder="Discount amount">
      <input id="ownerProductStock" type="number" placeholder="Stock">
      <select id="ownerProductStatus"><option value="active">Active</option><option value="hidden">Hidden</option><option value="draft">Draft</option></select>
      <input id="ownerProductImages" type="file" accept="image/*" multiple>
      <div class="owner-note">Exports and backup</div>
      <a class="btn btn-secondary" href="${apiUrl('/api/export/products.csv')}">Products CSV</a>
      <a class="btn btn-secondary" href="${apiUrl('/api/export/orders.csv')}">Orders CSV</a>
      <a class="btn btn-secondary" href="${apiUrl('/api/export/orders.pdf')}">Orders PDF</a>
      <button class="btn btn-primary" type="button" onclick="createBackup()"><i class="fas fa-download"></i> Backup Database</button>
      <textarea id="restorePayload" placeholder="Paste backup JSON to restore"></textarea>
      <button class="btn btn-secondary" type="button" onclick="restoreBackup()"><i class="fas fa-upload"></i> Restore Backup</button>`;
            tools.appendChild(div);
        }
        window.unlockOwnerPanel = async function() {
            const typed = document.getElementById('ownerPassword').value;
            const loginButton = document.querySelector('#ownerLogin .btn-primary');
            const oldText = loginButton ? loginButton.innerHTML : '';
            if (loginButton) { loginButton.disabled = true; loginButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening...'; }
            try {
                await api('/api/auth/owner-login', { method: 'POST', body: JSON.stringify({ password: typed }) });
                ownerMode = true;
                document.getElementById('ownerLogin').style.display = 'none';
                document.getElementById('ownerTools').style.display = 'grid';
                enhanceOwnerFields();
                await renderOwnerDashboard();
                setInterval(() => { if (ownerMode) renderOwnerDashboard(); }, 5000);
            } catch (error) {
                alert(error.message + ' Please check OWNER_PASSWORD in Render Environment.');
            } finally {
                if (loginButton && !ownerMode) { loginButton.disabled = false; loginButton.innerHTML = oldText; }
            }
        };
        async function renderOwnerDashboard() {
            const data = await api('/api/dashboard', { method: 'GET' });
            const statsBox = document.getElementById('ownerOrderStats');
            const listBox = document.getElementById('ownerOrdersList');
            const cards = data.cards;
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
            ].map(([label, value]) => `<div class="order-stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
            listBox.innerHTML = '<h4>Orders</h4>' + (data.recent_orders.length ? data.recent_orders.map(order => `
      <div class="owner-order">
        <strong>${order.id} - ${money(order.total)}</strong>
        <span>${order.customer_name} | ${order.phone}</span>
        <span>${order.address}</span>
        <span>${order.items.map(item => item.name + ' x ' + item.quantity).join(', ')}</span>
        <select onchange="updateOrderStatus('${order.id}', this.value)">
          ${['pending','processing','completed','cancelled'].map(status => `<option value="${status}" ${order.order_status === status ? 'selected' : ''}>${status}</option>`).join('')}
        </select>
        <a class="btn btn-secondary" target="_blank" href="${apiUrl('/api/orders/' + order.id + '/invoice')}">Print Invoice</a>
      </div>`).join('') : '<p class="owner-note">No order yet.</p>') +
      '<h4>Low Stock Products</h4>' + (data.low_stock.length ? data.low_stock.map(p => `<div class="owner-order"><strong>${p.name}</strong><span>Stock: ${p.stock}</span></div>`).join('') : '<p class="owner-note">No low stock products.</p>') +
      '<h4>Notifications</h4>' + (data.notifications.length ? data.notifications.map(n => `<div class="order-status-card">${n.message}</div>`).join('') : '<p class="owner-note">No new notifications.</p>');
  }
  window.updateOrderStatus = async function(orderId, status){
    await api('/api/orders/' + encodeURIComponent(orderId), {method:'PATCH', body:JSON.stringify({order_status:status})});
    await renderOwnerDashboard();
  };
  window.saveOwnerProduct = async function(){
    const title = document.getElementById('ownerProductTitle').value.trim();
    const price = document.getElementById('ownerProductPrice').value.trim().replace(/[^0-9.]/g, '');
    if (!title || !price) { alert('Product name aur price zaroori hain.'); return; }
    const form = new FormData();
    form.append('sku', document.getElementById('ownerProductSku')?.value || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    form.append('name', title);
    form.append('price', price);
    form.append('image_url', document.getElementById('ownerProductImage').value.trim());
    form.append('category_slug', document.getElementById('ownerProductCategory').value);
    form.append('category', document.getElementById('ownerProductCategory').selectedOptions[0].textContent);
    form.append('brand', document.getElementById('ownerProductBrand')?.value || 'Friends Traders');
    form.append('description', document.getElementById('ownerProductDescription').value.trim());
    form.append('discount', document.getElementById('ownerProductDiscount')?.value || 0);
    form.append('stock', document.getElementById('ownerProductStock')?.value || 10);
    form.append('status', document.getElementById('ownerProductStatus')?.value || 'active');
    Array.from(document.getElementById('ownerProductImages')?.files || []).forEach(file => form.append('images', file));
    try {
      const response = await fetch(apiUrl('/api/products'), {method:'POST', credentials:'include', headers:{'X-CSRF-Token':csrfToken}, body:form});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not save product');
      alert('Product saved permanently and website grid me show ho ga.');
      await renderBackendProducts();
      await renderOwnerDashboard();
    } catch (error) { alert(error.message); }
  };
  window.clearOwnerProducts = function(){ alert('Temporary browser products are disabled. Products are now stored permanently in database.'); };
  window.createBackup = async function(){
    const data = await api('/api/backup', {method:'POST', body:'{}'});
    document.getElementById('restorePayload').value = JSON.stringify(data.backup, null, 2);
    alert('Backup created: ' + data.path);
  };
  window.restoreBackup = async function(){
    await api('/api/restore', {method:'POST', body:document.getElementById('restorePayload').value || '{}'});
    alert('Backup restored.');
    await renderOwnerDashboard();
  };
  document.addEventListener('DOMContentLoaded', async () => {
    await initCsrf();
    await renderBackendProducts();
    wireBackendCartButtons();
    await renderBackendCart();
  });
})();
