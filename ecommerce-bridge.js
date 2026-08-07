(function() {
  let csrfToken = '';
  let ownerMode = false;
  let ownerRefreshTimer = null;
  let currentUser = null;
  let editingProductId = null;
  const backendHost = location.hostname === 'localhost' ? 'localhost' : '127.0.0.1';
  const isRenderHost = location.hostname.includes('onrender.com');
  const isStaticPreview = location.protocol === 'file:' || ['5500', '5501'].includes(location.port);
  const apiBase = isStaticPreview ? `http://${backendHost}:5001` : '';
  const apiUrl = url => apiBase + url;
  const assetUrl = url => (url && url.startsWith('/')) ? apiBase + url : url;
  const money = value => 'PKR ' + Number(value || 0).toLocaleString('en-PK');
  const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  const slugify = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'product';
  window.useBackendCart = true;

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
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
    try {
      const response = await fetch(apiUrl(url), { credentials: 'include', ...options, signal: controller.signal, headers: { ...headers, ...(options.headers || {}) } });
      const data = await response.json().catch(() => ({}));
      if (response.status === 403 && retry && String(data.error || '').toLowerCase().includes('security token')) {
        await initCsrf();
        return api(url, options, false);
      }
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Server response slow hai. Render/Supabase wake hone ke baad dobara try karein.');
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
      rosepetal: 'Rose Petal', chef: 'Chef', sk: 'SK', thermos: 'Thermos', plates: 'Plates',
      'cups-mugs': 'Cups & Mugs', 'glasses-drinkware': 'Glasses & Drinkware', 'lunch-boxes': 'Lunch Boxes',
      'water-bottles': 'Water Bottles', dinnerware: 'Dinner Sets', utensils: 'Kitchen Essentials', storage: 'Storage Containers',
      appliances: 'Electric Kitchen Appliances', 'stainless-steel': 'Stainless Steel', 'air-fryers': 'Air Fryers', random: 'Random Products', misc: 'Other Brands / Miscellaneous'
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
            <button class="product-btn add-cart-btn" type="button" onclick="window.addToCart('${escapeHtml(product.id)}', this)" ${product.out_of_stock ? 'disabled' : ''}><i class="fas fa-cart-plus"></i> Add to Cart</button>
          </div>
        </div>
      </div>`;
  }

  async function renderBackendProducts() {
    const grid = document.querySelector('.products-grid');
    if (!grid) return;
    const data = await api('/api/products?per_page=500', { method: 'GET' });
    const existing = new Set(Array.from(document.querySelectorAll('.product-card')).map(card => String(card.dataset.title || '').trim().toLowerCase()));
    const fresh = data.products.filter(product => !existing.has(String(product.name || '').trim().toLowerCase()));
    if (fresh.length) grid.insertAdjacentHTML('beforeend', fresh.map(backendProductCard).join(''));
    wireBackendCartButtons();
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

  async function renderBackendCart() {
    renderCartData(await getCart());
  }

  window.addToCart = async function(productId, button) {
    const btn = button || null;
    const oldHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...'; }
    try {
      const cart = await api('/api/cart/items', { method: 'POST', body: JSON.stringify({ product_id: productId, quantity: 1 }), timeoutMs: 20000 });
      renderCartData(cart);
      showCartPanel();
    } catch (error) {
      alert(error.message || 'Could not add to cart. Please try again.');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = oldHtml || '<i class="fas fa-cart-plus"></i> Add to Cart'; }
    }
  };

  window.updateCartQty = async function(productId, delta) {
    const cart = await getCart();
    const item = cart.items.find(row => row.product_id === productId);
    await api('/api/cart/items/' + encodeURIComponent(productId), { method: 'PATCH', body: JSON.stringify({ quantity: Math.max(0, (item ? item.quantity : 0) + delta) }) });
    await renderBackendCart();
  };

  window.removeFromCart = async function(productId) {
    await api('/api/cart/items/' + encodeURIComponent(productId), { method: 'PATCH', body: JSON.stringify({ quantity: 0 }) });
    await renderBackendCart();
  };

  window.openCart = async function() {
    await renderBackendCart();
    if (currentUser) await renderCustomerOrderStatus();
    showCartPanel();
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
    if (!customerName || !customerPhone || !customerAddress) { alert('Name, mobile number and complete address are compulsory.'); return; }
    if (!customerAddress.toLowerCase().includes('multan')) { alert('Abhi delivery sirf Multan ke liye available hai. Address me Multan zaroor likhein.'); return; }
    try {
      const data = await api('/api/checkout', { method: 'POST', body: JSON.stringify({ customer: { name: customerName, phone: customerPhone, address: customerAddress }, payment_method: 'cod' }) });
      document.getElementById('customerName').value = '';
      document.getElementById('customerPhone').value = '';
      document.getElementById('customerAddress').value = '';
      alert('Order saved permanently: ' + data.order.id + '. Owner panel me lazmi show ho ga.');
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
    if (loginButton) { loginButton.disabled = true; loginButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening...'; }
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
      if (loginButton && !ownerMode) { loginButton.disabled = false; loginButton.innerHTML = oldText; }
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
        ['Products', cards.total_products], ['Orders', cards.total_orders], ['Pending', cards.pending_orders], ['Processing', cards.processing_orders],
        ['Completed', cards.completed_orders], ['Cancelled', cards.cancelled_orders], ['Revenue', money(cards.revenue)], ['Today', money(cards.today_sales)], ['Month', money(cards.monthly_sales)]
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
    try {
      const editId = editingProductId || document.getElementById('ownerEditingProductId')?.value;
      const response = await fetch(apiUrl(editId ? '/api/products/' + encodeURIComponent(editId) : '/api/products'), { method: editId ? 'PUT' : 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken }, body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not save product');
      ['ownerProductTitle','ownerProductPrice','ownerProductImage','ownerProductDescription','ownerProductSku','ownerProductBrand','ownerProductDiscount','ownerProductStock','ownerProductFeatures','ownerEditingProductId'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      editingProductId = null;
      const files = document.getElementById('ownerProductImages'); if (files) files.value = '';
      alert(editId ? 'Product updated.' : 'Product saved permanently and website grid me show ho ga.');
      await renderBackendProducts();
      await renderOwnerDashboard();
    } catch (error) { alert(error.message); }
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

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await initCsrf();
      await renderBackendProducts();
      wireBackendCartButtons();
      await renderBackendCart();
    } catch (error) {
      console.warn('Backend ecommerce unavailable:', error.message);
    }
  });
})();
