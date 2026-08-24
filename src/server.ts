import express, { Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import dotenv from "dotenv";
import path from "path";
import { z } from "zod";
import nodemailer from "nodemailer";
import { GoogleGenerativeAI } from "@google/generative-ai";
import cors from "cors";

dotenv.config({ path: path.join(process.cwd(), ".env") });

const app = express();
const port = process.env.PORT || 5000;

// CORS Middleware
app.use(cors());

// Body Parser Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.CONNECTION_STR,
});

// 2. Database Tables Initialization
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        avatar VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Insert a default user if none exists
    await pool.query(`
      INSERT INTO users (id, name, email, created_at)
      VALUES (1, 'Default User', 'default@example.com', NOW())
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`

      CREATE TABLE IF NOT EXISTS businesses (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        company_name VARCHAR(150) NOT NULL,
        logo TEXT,
        contact_person VARCHAR(100) NOT NULL,
        email VARCHAR(150) NOT NULL,
        phone VARCHAR(20),
        website VARCHAR(150),
        address TEXT NOT NULL,
        vat_tax_id VARCHAR(50),
        default_currency VARCHAR(10) DEFAULT 'USD',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
        company_name VARCHAR(150) NOT NULL,
        contact_person VARCHAR(100) NOT NULL,
        email VARCHAR(150) NOT NULL,
        phone VARCHAR(20),
        billing_address TEXT NOT NULL,
        vat_number VARCHAR(50),
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payment_methods (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
        provider_name VARCHAR(50) NOT NULL,
        account_holder VARCHAR(100) NOT NULL,
        account_identifier VARCHAR(100) NOT NULL,
        swift_iban VARCHAR(100),
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
        client_id INT REFERENCES clients(id) ON DELETE CASCADE,
        payment_method_id INT REFERENCES payment_methods(id) ON DELETE SET NULL,
        invoice_number VARCHAR(50) UNIQUE NOT NULL,
        invoice_date DATE NOT NULL,
        due_date DATE NOT NULL,
        currency VARCHAR(10) NOT NULL,
        status VARCHAR(20) DEFAULT 'Draft',
        subtotal NUMERIC(10, 2) NOT NULL,
        tax NUMERIC(10, 2) DEFAULT 0,
        grand_total NUMERIC(10, 2) NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS invoice_items (
        id SERIAL PRIMARY KEY,
        invoice_id INT REFERENCES invoices(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        quantity NUMERIC(10, 2) NOT NULL,
        unit_rate NUMERIC(10, 2) NOT NULL,
        amount NUMERIC(10, 2) NOT NULL
      );
    `);
    console.log("Database tables initialized successfully.");
  } catch (error) {
    console.error("Error initializing database:", error);
  }
};

initDB();

// 3. Gemini AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// 4. Nodemailer Setup (Gmail SMTP)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS, // App Password
  },
});

// 5. Zod Validation Schemas
const businessSchema = z.object({
  company_name: z.string().min(1, "Company name is required"),
  logo: z.string().optional(),
  contact_person: z.string().min(1, "Contact person is required"),
  email: z.string().email("Invalid email"),
  phone: z.string().optional(),
  website: z.string().optional(),
  address: z.string().min(1, "Address is required"),
  vat_tax_id: z.string().optional(),
  default_currency: z.string().default("USD"),
});

const clientSchema = z.object({
  business_id: z.number().int(),
  company_name: z.string().min(1),
  contact_person: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  billing_address: z.string().min(1),
  vat_number: z.string().optional(),
  notes: z.string().optional(),
});

const paymentMethodSchema = z.object({
  business_id: z.number().int(),
  provider_name: z.string().min(1),
  account_holder: z.string().min(1),
  account_identifier: z.string().min(1),
  swift_iban: z.string().optional(),
  is_default: z.boolean().default(false),
});

const invoiceSchema = z.object({
  business_id: z.number().int(),
  client_id: z.number().int(),
  payment_method_id: z.number().int().optional(),
  invoice_date: z.string(),
  due_date: z.string(),
  currency: z.string(),
  status: z.enum(["Draft", "Sent", "Paid", "Overdue", "Cancelled"]).default("Draft"),
  tax_rate: z.number().default(0),
  notes: z.string().optional(),
  items: z.array(
    z.object({
      description: z.string().min(1),
      quantity: z.number().gt(0),
      unit_rate: z.number().gte(0),
    })
  ).min(1, "At least one item is required"),
});

// Async Error Handler Wrapper
const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Middleware for Authenticated User ID
const getAuthUserId = (req: Request): number => {
  // Pull from request header with fallback to default user (1)
  const userId = req.headers["x-user-id"];
  if (userId && !isNaN(Number(userId))) {
    return Number(userId);
  }
  return 1; // Default user fallback
};

// ==========================================
// API ROUTES
// ==========================================

// --- BUSINESS API ---
app.post("/api/businesses", asyncHandler(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const data = businessSchema.parse(req.body);

  const result = await pool.query(
    `INSERT INTO businesses 
     (user_id, company_name, logo, contact_person, email, phone, website, address, vat_tax_id, default_currency) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [userId, data.company_name, data.logo, data.contact_person, data.email, data.phone, data.website, data.address, data.vat_tax_id, data.default_currency]
  );

  res.status(201).json({ success: true, data: result.rows[0] });
}));

app.get("/api/businesses", asyncHandler(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await pool.query("SELECT * FROM businesses WHERE user_id = $1 ORDER BY id DESC", [userId]);
  res.json({ success: true, data: result.rows });
}));

// --- CLIENT API ---
app.post("/api/clients", asyncHandler(async (req: Request, res: Response) => {
  const data = clientSchema.parse(req.body);
  const result = await pool.query(
    `INSERT INTO clients 
     (business_id, company_name, contact_person, email, phone, billing_address, vat_number, notes) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [data.business_id, data.company_name, data.contact_person, data.email, data.phone, data.billing_address, data.vat_number, data.notes]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));

app.get("/api/clients", asyncHandler(async (req: Request, res: Response) => {
  const { business_id, search } = req.query;
  let query = "SELECT * FROM clients WHERE business_id = $1";
  const queryParams: any[] = [business_id];

  if (search) {
    query += " AND (company_name ILIKE $2 OR contact_person ILIKE $2 OR email ILIKE $2)";
    queryParams.push(`%${search}%`);
  }

  const result = await pool.query(query, queryParams);
  res.json({ success: true, data: result.rows });
}));

// --- PAYMENT METHOD API ---
app.post("/api/payment-methods", asyncHandler(async (req: Request, res: Response) => {
  const data = paymentMethodSchema.parse(req.body);
  const result = await pool.query(
    `INSERT INTO payment_methods 
     (business_id, provider_name, account_holder, account_identifier, swift_iban, is_default) 
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [data.business_id, data.provider_name, data.account_holder, data.account_identifier, data.swift_iban, data.is_default]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));

// --- INVOICE API ---
app.post("/api/invoices", asyncHandler(async (req: Request, res: Response) => {
  const dbClient = await pool.connect();
  try {
    const userId = getAuthUserId(req);
    const data = invoiceSchema.parse(req.body);

    await dbClient.query("BEGIN");

    const itemsWithAmount = data.items.map((item) => ({
      ...item,
      amount: item.quantity * item.unit_rate,
    }));
    const subtotal = itemsWithAmount.reduce((sum, item) => sum + item.amount, 0);
    const tax = subtotal * (data.tax_rate / 100);
    const grandTotal = subtotal + tax;

    const countRes = await dbClient.query("SELECT COUNT(*) FROM invoices");
    const invoiceNumber = `INV-${String(parseInt(countRes.rows[0].count) + 1).padStart(4, "0")}`;

    const invoiceRes = await dbClient.query(
      `INSERT INTO invoices 
       (user_id, business_id, client_id, payment_method_id, invoice_number, invoice_date, due_date, currency, status, subtotal, tax, grand_total, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [userId, data.business_id, data.client_id, data.payment_method_id, invoiceNumber, data.invoice_date, data.due_date, data.currency, data.status, subtotal, tax, grandTotal, data.notes]
    );

    const invoiceId = invoiceRes.rows[0].id;

    for (const item of itemsWithAmount) {
      await dbClient.query(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_rate, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoiceId, item.description, item.quantity, item.unit_rate, item.amount]
      );
    }

    await dbClient.query("COMMIT");
    res.status(201).json({ success: true, data: { ...invoiceRes.rows[0], items: itemsWithAmount } });
  } catch (err: any) {
    await dbClient.query("ROLLBACK");
    res.status(400).json({ success: false, error: err.errors || err.message });
  } finally {
    dbClient.release();
  }
}));

app.get("/api/invoices", asyncHandler(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { status, business_id, client_id, search } = req.query;

  let query = `
    SELECT i.*, c.company_name AS client_name, b.company_name AS business_name 
    FROM invoices i
    JOIN clients c ON i.client_id = c.id
    JOIN businesses b ON i.business_id = b.id
    WHERE i.user_id = $1
  `;
  const params: any[] = [userId];

  if (status) {
    params.push(status);
    query += ` AND i.status = $${params.length}`;
  }
  if (business_id) {
    params.push(business_id);
    query += ` AND i.business_id = $${params.length}`;
  }
  if (client_id) {
    params.push(client_id);
    query += ` AND i.client_id = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    query += ` AND (i.invoice_number ILIKE $${params.length} OR c.company_name ILIKE $${params.length})`;
  }

  query += " ORDER BY i.created_at DESC";
  const result = await pool.query(query, params);
  res.json({ success: true, data: result.rows });
}));

// --- DASHBOARD METRICS API ---
app.get("/api/dashboard/metrics", asyncHandler(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const metrics = await pool.query(
    `SELECT 
       COALESCE(SUM(CASE WHEN status = 'Paid' THEN grand_total ELSE 0 END), 0) AS total_revenue,
       COUNT(CASE WHEN status = 'Paid' THEN 1 END) AS paid_invoices_count,
       COALESCE(SUM(CASE WHEN status IN ('Sent', 'Overdue') THEN grand_total ELSE 0 END), 0) AS outstanding_amount,
       COUNT(CASE WHEN status = 'Overdue' THEN 1 END) AS overdue_count
     FROM invoices WHERE user_id = $1`,
    [userId]
  );

  const recentInvoices = await pool.query(
    `SELECT i.*, c.company_name as client_name 
     FROM invoices i 
     JOIN clients c ON i.client_id = c.id 
     WHERE i.user_id = $1 ORDER BY i.created_at DESC LIMIT 5`,
    [userId]
  );

  res.json({
    success: true,
    data: {
      metrics: metrics.rows[0],
      recentInvoices: recentInvoices.rows,
    },
  });
}));

// --- GEMINI AI REQUIREMENT API ---
app.post("/api/ai/generate-invoice-items", asyncHandler(async (req: Request, res: Response) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ success: false, error: "Prompt is required" });

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const systemPrompt = `Extract professional line items from this prompt. Return ONLY a valid JSON array of objects with fields "description" (string), "quantity" (number), and "unit_rate" (number). Prompt: "${prompt}"`;

  const result = await model.generateContent(systemPrompt);
  const rawText = result.response.text().replace(/```json|```/g, "").trim();
  const parsedItems = JSON.parse(rawText);

  res.json({ success: true, items: parsedItems });
}));

app.post("/api/invoices/:id/send", asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const invoiceQuery = await pool.query(
    `SELECT i.*, c.email AS client_email, c.company_name AS client_name 
     FROM invoices i 
     JOIN clients c ON i.client_id = c.id 
     WHERE i.id = $1`,
    [id]
  );

  if (invoiceQuery.rows.length === 0) {
    return res.status(404).json({ success: false, error: "Invoice not found" });
  }

  const invoice = invoiceQuery.rows[0];

  // Send Email via Gmail SMTP
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: invoice.client_email,
    subject: `Invoice ${invoice.invoice_number} from your service provider`,
    text: `Dear ${invoice.client_name},\n\nPlease find the invoice ${invoice.invoice_number} attached. Total amount: ${invoice.currency} ${invoice.grand_total}.\n\nThank you!`,
  });

  // Update Status
  await pool.query("UPDATE invoices SET status = 'Sent' WHERE id = $1", [id]);

  res.json({ success: true, message: "Invoice sent successfully!" });
}));

// Root Diagnostic Routes
app.get("/", (req: Request, res: Response) => {
  res.send("Invoice Management SaaS API (PostgreSQL Stack) is active.");
});

// Global Error Handler Middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || "Internal server error",
  });
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});