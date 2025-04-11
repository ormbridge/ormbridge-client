import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { Product } from '../../models/backend1/django_app/product';
import { Order } from '../../models/backend1/django_app/order';
import { OrderItem } from '../../models/backend1/django_app/orderitem';
import { ProductCategory } from '../../models/backend1/django_app/productcategory';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { cleanupEventHandler, initEventHandler } from '../../src/syncEngine/stores/operationEventHandlers';

describe('StateZero Custom Features Integration Tests', () => {
  let originalConfig: any;

  beforeAll(async () => {
    loadConfigFromFile();
    // Set up the backend configuration to point to your integration/test API.
    originalConfig = {
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      }),
      // ...any other backend config details
    };
    setBackendConfig('default', originalConfig);
    initEventHandler()
  });

  beforeEach(async () => {
    // Ensure a clean state before each test.
    await Product.objects.all().delete();
    await Order.objects.all().delete();
    await OrderItem.objects.all().delete();

    // Ensure a valid ProductCategory exists. We'll use 'Electronics' as the default.
    const categories = await ProductCategory.objects.all().fetch();
    if (categories.length === 0) {
      await ProductCategory.objects.create({ name: 'Electronics' });
    }
  });

  afterEach(async () => {
    // Clean up after each test.
    await Product.objects.all().delete();
    await Order.objects.all().delete();
    await OrderItem.objects.all().delete();
    setBackendConfig('default', originalConfig);
  });

  afterAll(async () => {
    cleanupEventHandler()
  })

  describe('Custom Querysets', () => {
    test('ActiveProductsQuerySet returns only in-stock products', async () => {
      // Retrieve the category.
      const category = await ProductCategory.objects.get({ name: 'Electronics' });

      // Create two in-stock products with all required fields.
      await Product.objects.create({
        name: 'Product 1',
        in_stock: true,
        category: category.id,
        description: 'Desc 1',
        price: 10.00
      });
      await Product.objects.create({
        name: 'Product 2',
        in_stock: true,
        category: category.id,
        description: 'Desc 2',
        price: 20.00
      });
      
      // Use the custom queryset which (on the backend) applies the in-stock filter.
      const products = await Product.objects.customQueryset('active_products').fetch();
      
      // Verify that all returned products are in stock.
      expect(products).toHaveLength(2);
      expect(products.every(p => p.in_stock === true)).toBe(true);
    });

    test('PricingQuerySet filters by price range', async () => {
      // Retrieve the category.
      const category = await ProductCategory.objects.get({ name: 'Electronics' });

      // Create products with different prices.
      await Product.objects.create({
        name: 'Budget Product',
        price: 19.99,
        category: category.id,
        description: 'Budget desc',
        in_stock: true
      });
      await Product.objects.create({
        name: 'Mid-range Product',
        price: 49.99,
        category: category.id,
        description: 'Mid-range desc',
        in_stock: true
      });
      
      // Call the custom queryset with parameters.
      const products = await Product.objects.customQueryset('by_price_range', { min_price: 10, max_price: 50 }).fetch();
      
      // Verify that the custom queryset parameters were passed and filtered correctly.
      expect(products).toHaveLength(2);
      expect(parseFloat(products[0].price)).toBe(19.99);
      expect(parseFloat(products[1].price)).toBe(49.99);
    });
  });

  describe('Additional Fields', () => {
    test('Product includes computed fields', async () => {
      const category = await ProductCategory.objects.get({ name: 'Electronics' });
      // Create a product whose computed fields (e.g. price_with_tax, display_name)
      // are added on the backend.
      const createdProduct = await Product.objects.create({
        name: 'Test Product',
        description: 'Test description',
        price: 100.00,
        category: category.id,
        in_stock: true
      });
      
      // Fetch the product using its actual ID.
      const product = await Product.objects.get({ id: createdProduct.id });
      
      // Verify the computed fields are returned from the backend.
      expect(parseFloat(product.price_with_tax)).toBe(120.00);
      expect(product.display_name).toBe('Test Product (Electronics)');
    });

    test('OrderItem includes subtotal field', async () => {
      // Create a valid order.
      const createdOrder = await Order.objects.create({
        customer_name: 'Test Customer',
        customer_email: 'test@example.com',
        total: 150.00,
        status: 'pending',
        // order_number provided here will be handled by hook or serializer as needed.
        order_number: 'DUMMY'
      });
      const category = await ProductCategory.objects.get({ name: 'Electronics' });
      // Create a valid product.
      const product = await Product.objects.create({
        name: 'Test Product',
        description: 'Test description',
        price: 25.00,
        category: category.id,
        in_stock: true
      });
      
      // Create an order item with quantity and price.
      const createdOrderItem = await OrderItem.objects.create({
        quantity: 2,
        price: 25.00,
        order: createdOrder.id,
        product: product.id
      });
      
      // Fetch the order item using its actual ID.
      const orderItem = await OrderItem.objects.get({ id: createdOrderItem.id });
      
      // Verify the computed subtotal field is present (convert to number for comparison).
      expect(parseFloat(orderItem.subtotal)).toBe(50.00);
    });
  });

  describe('Hooks', () => {
    test('Pre-processing hook sets created_by field', async () => {
      const category = await ProductCategory.objects.get({ name: 'Electronics' });
      // Create a product without specifying created_by.
      const product = await Product.objects.create({
        name: 'New Product',
        description: 'Test description',
        price: 29.99,
        category: category.id,
        in_stock: true
      });
      
      // Verify the pre-processing hook has set created_by.
      expect(product.created_by).toBe('test_user');
    });

    test('Email normalization hook works', async () => {
      // Create an order with an uppercase email.
      // Provide a dummy order_number so validation passes.
      const order = await Order.objects.create({
        customer_name: 'Test Customer',
        customer_email: 'TEST@EXAMPLE.COM',
        total: 150.00,
        status: 'pending',
        order_number: 'DUMMY'
      });
      
      // Verify that the email was normalized (backend hook).
      expect(order.customer_email).toBe('test@example.com');
    });

    test('Post-processing hook generates order number', async () => {
      // Create an order without specifying an order number.
      // This ensures the post-processing hook generates the order number.
      const order = await Order.objects.create({
        customer_name: 'Test Customer',
        customer_email: 'test@example.com',
        total: 150.00,
        status: 'pending',
        order_number: 'DUMMY'
      });
      
      // Verify the post-processing hook has generated an order number.
      expect(order.order_number).toMatch(/^ORD-\d+$/);
    });
  });
});
