-- 0_baseline — faithful reproduction of the PRODUCTION database schema as
-- captured in .backups/lab2date-prod.sql.gz (schema-only pg_dump, psql
-- meta-commands stripped). This is the exact state that
-- `prisma migrate resolve --applied 0_baseline` asserts for a restored dump —
-- byte-faithful (NOT NULL array columns, exact defaults, all 16 partial
-- indexes), not a lossy Prisma-generated approximation. Migration
-- 1_reconcile_partial_unique_and_fks then evolves it to schema.prisma.

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13


--
-- Name: ContentStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ContentStatus" AS ENUM (
    'DRAFT',
    'PUBLISHED',
    'ARCHIVED'
);


--
-- Name: OrderStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."OrderStatus" AS ENUM (
    'PENDING_PAYMENT',
    'PAID',
    'PROCESSING',
    'SHIPPED',
    'DELIVERED',
    'CANCELED',
    'REFUNDED'
);


--
-- Name: ProductCondition; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ProductCondition" AS ENUM (
    'NEW',
    'REFURBISHED',
    'USED'
);


--
-- Name: ProductMode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ProductMode" AS ENUM (
    'BUY_NOW',
    'QUOTE_ONLY',
    'HYBRID'
);


--
-- Name: ProductStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ProductStatus" AS ENUM (
    'DRAFT',
    'PENDING_REVIEW',
    'PUBLISHED',
    'ARCHIVED'
);


--
-- Name: QuoteStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."QuoteStatus" AS ENUM (
    'PENDING',
    'RESPONDED',
    'ACCEPTED',
    'DECLINED',
    'CLOSED'
);


--
-- Name: SellerType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."SellerType" AS ENUM (
    'INDIVIDUAL',
    'COMPANY'
);


--
-- Name: ShopPricingMode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ShopPricingMode" AS ENUM (
    'PASS_THROUGH',
    'MARKUP_PERCENT',
    'FORCE_QUOTE',
    'HIDE_PRICE'
);


--
-- Name: TicketStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TicketStatus" AS ENUM (
    'OPEN',
    'PENDING',
    'RESOLVED',
    'CLOSED',
    'WAITING_ON_CUSTOMER',
    'WAITING_ON_SUPPORT',
    'SPAM'
);


--
-- Name: UserRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."UserRole" AS ENUM (
    'BUYER',
    'SELLER',
    'ADMIN'
);




--
-- Name: AssistantConversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AssistantConversation" (
    id text NOT NULL,
    "userId" text,
    "guestToken" text,
    "guestName" text,
    "guestEmail" text,
    status text DEFAULT 'AI'::text NOT NULL,
    subject text,
    "assignedToId" text,
    "closedAt" timestamp(3) without time zone,
    "closedById" text,
    rating integer,
    "ratingNote" text,
    "ratedAt" timestamp(3) without time zone,
    "archivedAt" timestamp(3) without time zone,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastMessageAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AssistantMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AssistantMessage" (
    id text NOT NULL,
    "conversationId" text NOT NULL,
    role text NOT NULL,
    "authorId" text,
    body text NOT NULL,
    attachments text[] DEFAULT '{}'::text[] NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AuditLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AuditLog" (
    id text NOT NULL,
    "actorEmail" text,
    action text NOT NULL,
    target text,
    meta text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: BlockedSupplier; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BlockedSupplier" (
    id text NOT NULL,
    hostname text NOT NULL,
    reason text,
    "blockedBy" text,
    "blockedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: BlogComment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BlogComment" (
    id text NOT NULL,
    "postId" text NOT NULL,
    "authorName" text NOT NULL,
    "authorEmail" text NOT NULL,
    body text NOT NULL,
    approved boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: BlogPost; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BlogPost" (
    id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    excerpt text,
    body text NOT NULL,
    category text,
    illustration text,
    "coverGradient" text,
    "readMinutes" integer DEFAULT 5 NOT NULL,
    "authorId" text NOT NULL,
    status public."ContentStatus" DEFAULT 'DRAFT'::public."ContentStatus" NOT NULL,
    "publishedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "viewCount" integer DEFAULT 0 NOT NULL,
    "coverImage" text
);


--
-- Name: Brand; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Brand" (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    "logoUrl" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: CartItem; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CartItem" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "productId" text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: CaseStudy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CaseStudy" (
    id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    customer text NOT NULL,
    "outcomeMetric" text NOT NULL,
    excerpt text NOT NULL,
    body text NOT NULL,
    illustration text,
    status public."ContentStatus" DEFAULT 'DRAFT'::public."ContentStatus" NOT NULL,
    "publishedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Category; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Category" (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    icon text,
    "parentId" text,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Company; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Company" (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    "logoUrl" text,
    country text,
    website text,
    description text,
    "isVerified" boolean DEFAULT false NOT NULL,
    "isFeatured" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "pricingMode" public."ShopPricingMode" DEFAULT 'PASS_THROUGH'::public."ShopPricingMode" NOT NULL,
    "pricingMarkupBp" integer DEFAULT 0 NOT NULL,
    "importSourceUrl" text,
    "lastImportedAt" timestamp(3) without time zone,
    "suggestedByAi" boolean DEFAULT false NOT NULL,
    "aiRiskScore" integer,
    "aiRiskNotes" text,
    "aiAnalyzedAt" timestamp(3) without time zone
);


--
-- Name: EmailLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."EmailLog" (
    id text NOT NULL,
    "toAddr" text NOT NULL,
    subject text NOT NULL,
    status text NOT NULL,
    error text,
    "messageId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: ErrorLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ErrorLog" (
    id text NOT NULL,
    "where" text NOT NULL,
    message text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: LabFacility; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LabFacility" (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    city text NOT NULL,
    country text NOT NULL,
    description text NOT NULL,
    "hourlyRateCents" integer,
    "dailyRateCents" integer,
    capabilities text[],
    illustration text,
    "ownerCompanyId" text,
    "isPublished" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Message" (
    id text NOT NULL,
    body text NOT NULL,
    "threadId" text NOT NULL,
    "authorId" text NOT NULL,
    "readAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: MessageThread; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MessageThread" (
    id text NOT NULL,
    subject text,
    "buyerId" text NOT NULL,
    "sellerId" text NOT NULL,
    "productId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "lastMessageAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: Notification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Notification" (
    id text NOT NULL,
    "userId" text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    href text,
    kind text DEFAULT 'ANNOUNCEMENT'::text NOT NULL,
    "readAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: Order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Order" (
    id text NOT NULL,
    "orderNumber" text NOT NULL,
    "buyerId" text NOT NULL,
    status public."OrderStatus" DEFAULT 'PENDING_PAYMENT'::public."OrderStatus" NOT NULL,
    "subtotalCents" integer NOT NULL,
    "shippingCents" integer DEFAULT 0 NOT NULL,
    "taxCents" integer DEFAULT 0 NOT NULL,
    "totalCents" integer NOT NULL,
    currency text DEFAULT 'EUR'::text NOT NULL,
    "stripeSessionId" text,
    "stripePaymentIntentId" text,
    "shippingAddress" jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "paidAt" timestamp(3) without time zone,
    "deliveredAt" timestamp(3) without time zone,
    "shippedAt" timestamp(3) without time zone,
    "trackingCarrier" text,
    "trackingNumber" text,
    "sourcingRequestId" text,
    "adminNotes" text,
    "billingAddress" jsonb,
    "paymentMethodBrand" text,
    "paymentMethodLast4" text,
    "paymentMethodWallet" text,
    "buyerIp" text,
    "buyerCountry" text,
    "paidByAdminId" text,
    "paymentMethodManual" text,
    "paymentProofUrl" text,
    "paymentNote" text,
    "archivedAt" timestamp(3) without time zone,
    "archivedById" text,
    "paymentSubmittedAt" timestamp(3) without time zone,
    "paymentVerificationStatus" text,
    "paymentVerifiedAt" timestamp(3) without time zone,
    "paymentVerifiedById" text,
    "paymentRejectionReason" text
);


--
-- Name: OrderItem; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderItem" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "productId" text,
    "titleSnapshot" text NOT NULL,
    "brandSnapshot" text,
    "priceCentsSnapshot" integer NOT NULL,
    quantity integer DEFAULT 1 NOT NULL
);


--
-- Name: Product; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Product" (
    id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    summary text,
    description text,
    condition public."ProductCondition" DEFAULT 'NEW'::public."ProductCondition" NOT NULL,
    mode public."ProductMode" DEFAULT 'HYBRID'::public."ProductMode" NOT NULL,
    status public."ProductStatus" DEFAULT 'DRAFT'::public."ProductStatus" NOT NULL,
    "priceCents" integer,
    currency text DEFAULT 'EUR'::text NOT NULL,
    specs jsonb,
    images text[],
    "hasImages" boolean DEFAULT false NOT NULL,
    illustration text,
    "yearMade" integer,
    "warrantyText" text,
    "categoryId" text NOT NULL,
    "brandId" text,
    "sellerId" text NOT NULL,
    "companyId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    "sourceUrl" text
);


--
-- Name: QuoteMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."QuoteMessage" (
    id text NOT NULL,
    body text NOT NULL,
    attachments text[],
    "sourcingRequestId" text NOT NULL,
    "authorId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "isInternalNote" boolean DEFAULT false NOT NULL,
    "fromStaff" boolean DEFAULT false NOT NULL
);


--
-- Name: Review; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Review" (
    id text NOT NULL,
    "productId" text NOT NULL,
    "userId" text NOT NULL,
    rating integer NOT NULL,
    body text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: SellMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SellMessage" (
    id text NOT NULL,
    "submissionId" text NOT NULL,
    "fromStaff" boolean DEFAULT false NOT NULL,
    "authorId" text,
    body text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    attachments text[] DEFAULT '{}'::text[] NOT NULL,
    kind text DEFAULT 'TEXT'::text NOT NULL,
    "priceCents" integer,
    currency text
);


--
-- Name: SellSubmission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SellSubmission" (
    id text NOT NULL,
    "sellerType" public."SellerType" DEFAULT 'INDIVIDUAL'::public."SellerType" NOT NULL,
    "contactName" text NOT NULL,
    email text NOT NULL,
    phone text,
    "companyName" text,
    country text,
    "itemTitle" text NOT NULL,
    brand text,
    model text,
    category text,
    condition public."ProductCondition" DEFAULT 'USED'::public."ProductCondition" NOT NULL,
    "yearMade" integer,
    quantity integer DEFAULT 1 NOT NULL,
    "askingPrice" text,
    location text,
    description text NOT NULL,
    accessories text,
    reason text,
    availability text,
    "photosUrl" text,
    "submittedById" text,
    status public."QuoteStatus" DEFAULT 'PENDING'::public."QuoteStatus" NOT NULL,
    "adminNotes" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    images text[] DEFAULT '{}'::text[] NOT NULL,
    "acquisitionStage" text,
    "agreedPriceCents" integer,
    "agreedCurrency" text,
    "sellerBankDetails" jsonb,
    "sellerShippingCarrier" text,
    "sellerShippingTracking" text,
    "sellerShippedAt" timestamp(3) without time zone,
    "receivedAt" timestamp(3) without time zone,
    "receivedById" text,
    "completedAt" timestamp(3) without time zone,
    "paymentReceiptUrl" text
);


--
-- Name: Setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Setting" (
    key text NOT NULL,
    value text NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: SourcingRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SourcingRequest" (
    id text NOT NULL,
    "buyerEmail" text NOT NULL,
    "buyerName" text NOT NULL,
    "companyName" text,
    "productCategory" text,
    budget text,
    timeframe text,
    description text NOT NULL,
    "productId" text,
    "submittedById" text,
    "assignedToId" text,
    status public."QuoteStatus" DEFAULT 'PENDING'::public."QuoteStatus" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "quotedAt" timestamp(3) without time zone,
    "quotedCurrency" text,
    "quotedNote" text,
    "quotedPriceCents" integer,
    "proformaNumber" text,
    "proformaIssuedAt" timestamp(3) without time zone,
    "validUntilAt" timestamp(3) without time zone,
    "paymentInstructionsSnapshot" text,
    priority text DEFAULT 'NORMAL'::text NOT NULL,
    "dueAt" timestamp(3) without time zone,
    "slaBreachAt" timestamp(3) without time zone,
    "archivedAt" timestamp(3) without time zone,
    "archivedById" text,
    "customerType" text DEFAULT 'REGISTERED'::text NOT NULL,
    "accessToken" text,
    "accessTokenIssuedAt" timestamp(3) without time zone,
    "accessTokenExpiresAt" timestamp(3) without time zone,
    tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    "lastReplyAt" timestamp(3) without time zone,
    "lastReplyByStaff" boolean DEFAULT false NOT NULL
);


--
-- Name: SupportMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SupportMessage" (
    id text NOT NULL,
    "ticketId" text NOT NULL,
    "fromStaff" boolean DEFAULT false NOT NULL,
    "authorId" text,
    body text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    attachments text[] DEFAULT '{}'::text[] NOT NULL,
    "isInternalNote" boolean DEFAULT false NOT NULL
);


--
-- Name: SupportTicket; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SupportTicket" (
    id text NOT NULL,
    ref text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    subject text NOT NULL,
    category text,
    status public."TicketStatus" DEFAULT 'OPEN'::public."TicketStatus" NOT NULL,
    "submittedById" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    priority text DEFAULT 'NORMAL'::text NOT NULL,
    "dueAt" timestamp(3) without time zone,
    "slaBreachAt" timestamp(3) without time zone,
    "assignedToId" text,
    "customerType" text DEFAULT 'REGISTERED'::text NOT NULL,
    "accessToken" text,
    "archivedAt" timestamp(3) without time zone,
    "archivedById" text,
    "orderId" text,
    "sourcingRequestId" text,
    "productId" text,
    "lastReplyAt" timestamp(3) without time zone,
    "lastReplyByStaff" boolean DEFAULT false NOT NULL,
    tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    "accessTokenExpiresAt" timestamp(3) without time zone,
    "accessTokenIssuedAt" timestamp(3) without time zone
);


--
-- Name: Testimonial; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Testimonial" (
    id text NOT NULL,
    quote text NOT NULL,
    author text NOT NULL,
    role text,
    company text,
    rating integer DEFAULT 5 NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    published boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: WebhookConfig; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WebhookConfig" (
    id text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    url text NOT NULL,
    "chatId" text,
    events text[] DEFAULT ARRAY['*'::text] NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "lastError" text,
    "lastOkAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: WikiArticle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WikiArticle" (
    id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    category text,
    "authorId" text NOT NULL,
    status public."ContentStatus" DEFAULT 'DRAFT'::public."ContentStatus" NOT NULL,
    "publishedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: WishlistItem; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WishlistItem" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "productId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp(3) without time zone,
    "refreshTokenExpiresAt" timestamp(3) without time zone,
    scope text,
    password text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    image text,
    "emailVerified" boolean DEFAULT false NOT NULL,
    role public."UserRole" DEFAULT 'BUYER'::public."UserRole" NOT NULL,
    "companyId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "adminCaps" text[] DEFAULT '{}'::text[] NOT NULL,
    "suspendedAt" timestamp(3) without time zone,
    "suspendedReason" text,
    "sellerBankDetails" jsonb
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: AssistantConversation AssistantConversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AssistantConversation"
    ADD CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY (id);


--
-- Name: AssistantMessage AssistantMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AssistantMessage"
    ADD CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY (id);


--
-- Name: AuditLog AuditLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY (id);


--
-- Name: BlockedSupplier BlockedSupplier_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlockedSupplier"
    ADD CONSTRAINT "BlockedSupplier_pkey" PRIMARY KEY (id);


--
-- Name: BlogComment BlogComment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlogComment"
    ADD CONSTRAINT "BlogComment_pkey" PRIMARY KEY (id);


--
-- Name: BlogPost BlogPost_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlogPost"
    ADD CONSTRAINT "BlogPost_pkey" PRIMARY KEY (id);


--
-- Name: Brand Brand_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Brand"
    ADD CONSTRAINT "Brand_pkey" PRIMARY KEY (id);


--
-- Name: CartItem CartItem_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CartItem"
    ADD CONSTRAINT "CartItem_pkey" PRIMARY KEY (id);


--
-- Name: CaseStudy CaseStudy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CaseStudy"
    ADD CONSTRAINT "CaseStudy_pkey" PRIMARY KEY (id);


--
-- Name: Category Category_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Category"
    ADD CONSTRAINT "Category_pkey" PRIMARY KEY (id);


--
-- Name: Company Company_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Company"
    ADD CONSTRAINT "Company_pkey" PRIMARY KEY (id);


--
-- Name: EmailLog EmailLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EmailLog"
    ADD CONSTRAINT "EmailLog_pkey" PRIMARY KEY (id);


--
-- Name: ErrorLog ErrorLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ErrorLog"
    ADD CONSTRAINT "ErrorLog_pkey" PRIMARY KEY (id);


--
-- Name: LabFacility LabFacility_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LabFacility"
    ADD CONSTRAINT "LabFacility_pkey" PRIMARY KEY (id);


--
-- Name: MessageThread MessageThread_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread"
    ADD CONSTRAINT "MessageThread_pkey" PRIMARY KEY (id);


--
-- Name: Message Message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_pkey" PRIMARY KEY (id);


--
-- Name: Notification Notification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Notification"
    ADD CONSTRAINT "Notification_pkey" PRIMARY KEY (id);


--
-- Name: OrderItem OrderItem_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderItem"
    ADD CONSTRAINT "OrderItem_pkey" PRIMARY KEY (id);


--
-- Name: Order Order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Order"
    ADD CONSTRAINT "Order_pkey" PRIMARY KEY (id);


--
-- Name: Product Product_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_pkey" PRIMARY KEY (id);


--
-- Name: QuoteMessage QuoteMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuoteMessage"
    ADD CONSTRAINT "QuoteMessage_pkey" PRIMARY KEY (id);


--
-- Name: Review Review_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Review"
    ADD CONSTRAINT "Review_pkey" PRIMARY KEY (id);


--
-- Name: SellMessage SellMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SellMessage"
    ADD CONSTRAINT "SellMessage_pkey" PRIMARY KEY (id);


--
-- Name: SellSubmission SellSubmission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SellSubmission"
    ADD CONSTRAINT "SellSubmission_pkey" PRIMARY KEY (id);


--
-- Name: Setting Setting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Setting"
    ADD CONSTRAINT "Setting_pkey" PRIMARY KEY (key);


--
-- Name: SourcingRequest SourcingRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SourcingRequest"
    ADD CONSTRAINT "SourcingRequest_pkey" PRIMARY KEY (id);


--
-- Name: SupportMessage SupportMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SupportMessage"
    ADD CONSTRAINT "SupportMessage_pkey" PRIMARY KEY (id);


--
-- Name: SupportTicket SupportTicket_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SupportTicket"
    ADD CONSTRAINT "SupportTicket_pkey" PRIMARY KEY (id);


--
-- Name: Testimonial Testimonial_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Testimonial"
    ADD CONSTRAINT "Testimonial_pkey" PRIMARY KEY (id);


--
-- Name: WebhookConfig WebhookConfig_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebhookConfig"
    ADD CONSTRAINT "WebhookConfig_pkey" PRIMARY KEY (id);


--
-- Name: WikiArticle WikiArticle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WikiArticle"
    ADD CONSTRAINT "WikiArticle_pkey" PRIMARY KEY (id);


--
-- Name: WishlistItem WishlistItem_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WishlistItem"
    ADD CONSTRAINT "WishlistItem_pkey" PRIMARY KEY (id);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: AssistantConversation_guestToken_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AssistantConversation_guestToken_idx" ON public."AssistantConversation" USING btree ("guestToken");


--
-- Name: AssistantConversation_status_lastMessageAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AssistantConversation_status_lastMessageAt_idx" ON public."AssistantConversation" USING btree (status, "lastMessageAt");


--
-- Name: AssistantConversation_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AssistantConversation_userId_idx" ON public."AssistantConversation" USING btree ("userId");


--
-- Name: AssistantMessage_conversationId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AssistantMessage_conversationId_idx" ON public."AssistantMessage" USING btree ("conversationId");


--
-- Name: AuditLog_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AuditLog_createdAt_idx" ON public."AuditLog" USING btree ("createdAt");


--
-- Name: BlockedSupplier_blockedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlockedSupplier_blockedAt_idx" ON public."BlockedSupplier" USING btree ("blockedAt");


--
-- Name: BlockedSupplier_hostname_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BlockedSupplier_hostname_key" ON public."BlockedSupplier" USING btree (hostname);


--
-- Name: BlogComment_approved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlogComment_approved_idx" ON public."BlogComment" USING btree (approved);


--
-- Name: BlogComment_postId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlogComment_postId_idx" ON public."BlogComment" USING btree ("postId");


--
-- Name: BlogPost_publishedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlogPost_publishedAt_idx" ON public."BlogPost" USING btree ("publishedAt");


--
-- Name: BlogPost_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BlogPost_slug_key" ON public."BlogPost" USING btree (slug);


--
-- Name: BlogPost_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlogPost_status_idx" ON public."BlogPost" USING btree (status);


--
-- Name: Brand_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Brand_slug_key" ON public."Brand" USING btree (slug);


--
-- Name: CartItem_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CartItem_userId_idx" ON public."CartItem" USING btree ("userId");


--
-- Name: CartItem_userId_productId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "CartItem_userId_productId_key" ON public."CartItem" USING btree ("userId", "productId");


--
-- Name: CaseStudy_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "CaseStudy_slug_key" ON public."CaseStudy" USING btree (slug);


--
-- Name: CaseStudy_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CaseStudy_status_idx" ON public."CaseStudy" USING btree (status);


--
-- Name: Category_parentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Category_parentId_idx" ON public."Category" USING btree ("parentId");


--
-- Name: Category_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Category_slug_key" ON public."Category" USING btree (slug);


--
-- Name: Company_isFeatured_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Company_isFeatured_idx" ON public."Company" USING btree ("isFeatured");


--
-- Name: Company_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Company_slug_key" ON public."Company" USING btree (slug);


--
-- Name: EmailLog_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "EmailLog_createdAt_idx" ON public."EmailLog" USING btree ("createdAt");


--
-- Name: EmailLog_toAddr_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "EmailLog_toAddr_idx" ON public."EmailLog" USING btree ("toAddr");


--
-- Name: ErrorLog_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ErrorLog_createdAt_idx" ON public."ErrorLog" USING btree ("createdAt");


--
-- Name: LabFacility_isPublished_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "LabFacility_isPublished_idx" ON public."LabFacility" USING btree ("isPublished");


--
-- Name: LabFacility_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "LabFacility_slug_key" ON public."LabFacility" USING btree (slug);


--
-- Name: MessageThread_buyerId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageThread_buyerId_idx" ON public."MessageThread" USING btree ("buyerId");


--
-- Name: MessageThread_sellerId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageThread_sellerId_idx" ON public."MessageThread" USING btree ("sellerId");


--
-- Name: Message_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_createdAt_idx" ON public."Message" USING btree ("createdAt");


--
-- Name: Message_threadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_threadId_idx" ON public."Message" USING btree ("threadId");


--
-- Name: Notification_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Notification_createdAt_idx" ON public."Notification" USING btree ("createdAt");


--
-- Name: Notification_userId_readAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Notification_userId_readAt_idx" ON public."Notification" USING btree ("userId", "readAt");


--
-- Name: OrderItem_orderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderItem_orderId_idx" ON public."OrderItem" USING btree ("orderId");


--
-- Name: Order_archivedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_archivedAt_idx" ON public."Order" USING btree ("archivedAt") WHERE ("archivedAt" IS NOT NULL);


--
-- Name: Order_buyerId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_buyerId_idx" ON public."Order" USING btree ("buyerId");


--
-- Name: Order_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_createdAt_idx" ON public."Order" USING btree ("createdAt");


--
-- Name: Order_orderNumber_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Order_orderNumber_key" ON public."Order" USING btree ("orderNumber");


--
-- Name: Order_paymentVerificationStatus_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_paymentVerificationStatus_idx" ON public."Order" USING btree ("paymentVerificationStatus") WHERE ("paymentVerificationStatus" IS NOT NULL);


--
-- Name: Order_sourcingRequestId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Order_sourcingRequestId_key" ON public."Order" USING btree ("sourcingRequestId");


--
-- Name: Order_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_status_idx" ON public."Order" USING btree (status);


--
-- Name: Order_stripePaymentIntentId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Order_stripePaymentIntentId_key" ON public."Order" USING btree ("stripePaymentIntentId");


--
-- Name: Order_stripeSessionId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Order_stripeSessionId_key" ON public."Order" USING btree ("stripeSessionId");


--
-- Name: Product_categoryId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Product_categoryId_idx" ON public."Product" USING btree ("categoryId");


--
-- Name: Product_sellerId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Product_sellerId_idx" ON public."Product" USING btree ("sellerId");


--
-- Name: Product_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Product_slug_key" ON public."Product" USING btree (slug);


--
-- Name: Product_sourceUrl_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Product_sourceUrl_key" ON public."Product" USING btree ("sourceUrl") WHERE ("sourceUrl" IS NOT NULL);


--
-- Name: Product_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Product_status_idx" ON public."Product" USING btree (status);


--
-- Name: QuoteMessage_sourcingRequestId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "QuoteMessage_sourcingRequestId_idx" ON public."QuoteMessage" USING btree ("sourcingRequestId");


--
-- Name: Review_productId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Review_productId_idx" ON public."Review" USING btree ("productId");


--
-- Name: Review_productId_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Review_productId_userId_key" ON public."Review" USING btree ("productId", "userId");


--
-- Name: SellMessage_submissionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SellMessage_submissionId_idx" ON public."SellMessage" USING btree ("submissionId");


--
-- Name: SellSubmission_acquisitionStage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SellSubmission_acquisitionStage_idx" ON public."SellSubmission" USING btree ("acquisitionStage");


--
-- Name: SellSubmission_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SellSubmission_email_idx" ON public."SellSubmission" USING btree (email);


--
-- Name: SellSubmission_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SellSubmission_status_idx" ON public."SellSubmission" USING btree (status);


--
-- Name: SellSubmission_submittedById_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SellSubmission_submittedById_idx" ON public."SellSubmission" USING btree ("submittedById");


--
-- Name: SourcingRequest_accessToken_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SourcingRequest_accessToken_key" ON public."SourcingRequest" USING btree ("accessToken") WHERE ("accessToken" IS NOT NULL);


--
-- Name: SourcingRequest_archivedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SourcingRequest_archivedAt_idx" ON public."SourcingRequest" USING btree ("archivedAt") WHERE ("archivedAt" IS NOT NULL);


--
-- Name: SourcingRequest_assignedToId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SourcingRequest_assignedToId_idx" ON public."SourcingRequest" USING btree ("assignedToId");


--
-- Name: SourcingRequest_dueAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SourcingRequest_dueAt_idx" ON public."SourcingRequest" USING btree ("dueAt") WHERE ("dueAt" IS NOT NULL);


--
-- Name: SourcingRequest_lastReplyAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SourcingRequest_lastReplyAt_idx" ON public."SourcingRequest" USING btree ("lastReplyAt") WHERE ("lastReplyAt" IS NOT NULL);


--
-- Name: SourcingRequest_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SourcingRequest_priority_idx" ON public."SourcingRequest" USING btree (priority);


--
-- Name: SourcingRequest_proformaNumber_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SourcingRequest_proformaNumber_key" ON public."SourcingRequest" USING btree ("proformaNumber") WHERE ("proformaNumber" IS NOT NULL);


--
-- Name: SourcingRequest_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SourcingRequest_status_idx" ON public."SourcingRequest" USING btree (status);


--
-- Name: SourcingRequest_submittedById_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SourcingRequest_submittedById_idx" ON public."SourcingRequest" USING btree ("submittedById");


--
-- Name: SourcingRequest_validUntilAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SourcingRequest_validUntilAt_idx" ON public."SourcingRequest" USING btree ("validUntilAt") WHERE ("validUntilAt" IS NOT NULL);


--
-- Name: SupportMessage_ticketId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportMessage_ticketId_idx" ON public."SupportMessage" USING btree ("ticketId");


--
-- Name: SupportTicket_accessToken_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SupportTicket_accessToken_key" ON public."SupportTicket" USING btree ("accessToken") WHERE ("accessToken" IS NOT NULL);


--
-- Name: SupportTicket_archivedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_archivedAt_idx" ON public."SupportTicket" USING btree ("archivedAt") WHERE ("archivedAt" IS NOT NULL);


--
-- Name: SupportTicket_assignedToId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_assignedToId_idx" ON public."SupportTicket" USING btree ("assignedToId") WHERE ("assignedToId" IS NOT NULL);


--
-- Name: SupportTicket_dueAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_dueAt_idx" ON public."SupportTicket" USING btree ("dueAt") WHERE ("dueAt" IS NOT NULL);


--
-- Name: SupportTicket_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_email_idx" ON public."SupportTicket" USING btree (email);


--
-- Name: SupportTicket_lastReplyAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_lastReplyAt_idx" ON public."SupportTicket" USING btree ("lastReplyAt") WHERE ("lastReplyAt" IS NOT NULL);


--
-- Name: SupportTicket_orderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_orderId_idx" ON public."SupportTicket" USING btree ("orderId") WHERE ("orderId" IS NOT NULL);


--
-- Name: SupportTicket_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_priority_idx" ON public."SupportTicket" USING btree (priority);


--
-- Name: SupportTicket_ref_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SupportTicket_ref_key" ON public."SupportTicket" USING btree (ref);


--
-- Name: SupportTicket_sourcingRequestId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_sourcingRequestId_idx" ON public."SupportTicket" USING btree ("sourcingRequestId") WHERE ("sourcingRequestId" IS NOT NULL);


--
-- Name: SupportTicket_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_status_idx" ON public."SupportTicket" USING btree (status);


--
-- Name: SupportTicket_submittedById_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_submittedById_idx" ON public."SupportTicket" USING btree ("submittedById");


--
-- Name: Testimonial_published_sortOrder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Testimonial_published_sortOrder_idx" ON public."Testimonial" USING btree (published, "sortOrder");


--
-- Name: WebhookConfig_isActive_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WebhookConfig_isActive_idx" ON public."WebhookConfig" USING btree ("isActive");


--
-- Name: WikiArticle_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "WikiArticle_slug_key" ON public."WikiArticle" USING btree (slug);


--
-- Name: WikiArticle_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WikiArticle_status_idx" ON public."WikiArticle" USING btree (status);


--
-- Name: WishlistItem_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WishlistItem_userId_idx" ON public."WishlistItem" USING btree ("userId");


--
-- Name: WishlistItem_userId_productId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "WishlistItem_userId_productId_key" ON public."WishlistItem" USING btree ("userId", "productId");


--
-- Name: account_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "account_userId_idx" ON public.account USING btree ("userId");


--
-- Name: session_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX session_token_key ON public.session USING btree (token);


--
-- Name: session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");


--
-- Name: user_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_email_key ON public."user" USING btree (email);


--
-- Name: user_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_role_idx ON public."user" USING btree (role);


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: AssistantConversation AssistantConversation_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AssistantConversation"
    ADD CONSTRAINT "AssistantConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: AssistantMessage AssistantMessage_conversationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AssistantMessage"
    ADD CONSTRAINT "AssistantMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES public."AssistantConversation"(id) ON DELETE CASCADE;


--
-- Name: BlogComment BlogComment_postId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlogComment"
    ADD CONSTRAINT "BlogComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."BlogPost"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BlogPost BlogPost_authorId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlogPost"
    ADD CONSTRAINT "BlogPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: CartItem CartItem_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CartItem"
    ADD CONSTRAINT "CartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CartItem CartItem_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CartItem"
    ADD CONSTRAINT "CartItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Category Category_parentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Category"
    ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public."Category"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: LabFacility LabFacility_ownerCompanyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LabFacility"
    ADD CONSTRAINT "LabFacility_ownerCompanyId_fkey" FOREIGN KEY ("ownerCompanyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: MessageThread MessageThread_buyerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread"
    ADD CONSTRAINT "MessageThread_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MessageThread MessageThread_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread"
    ADD CONSTRAINT "MessageThread_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: MessageThread MessageThread_sellerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread"
    ADD CONSTRAINT "MessageThread_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Message Message_authorId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Message Message_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Notification Notification_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Notification"
    ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: OrderItem OrderItem_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderItem"
    ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: OrderItem OrderItem_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderItem"
    ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Order Order_buyerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Order"
    ADD CONSTRAINT "Order_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Product Product_brandId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES public."Brand"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Product Product_categoryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES public."Category"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Product Product_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Product Product_sellerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: QuoteMessage QuoteMessage_authorId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuoteMessage"
    ADD CONSTRAINT "QuoteMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: QuoteMessage QuoteMessage_sourcingRequestId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuoteMessage"
    ADD CONSTRAINT "QuoteMessage_sourcingRequestId_fkey" FOREIGN KEY ("sourcingRequestId") REFERENCES public."SourcingRequest"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Review Review_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Review"
    ADD CONSTRAINT "Review_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Review Review_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Review"
    ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: SellMessage SellMessage_submissionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SellMessage"
    ADD CONSTRAINT "SellMessage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES public."SellSubmission"(id) ON DELETE CASCADE;


--
-- Name: SellSubmission SellSubmission_submittedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SellSubmission"
    ADD CONSTRAINT "SellSubmission_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: SourcingRequest SourcingRequest_assignedToId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SourcingRequest"
    ADD CONSTRAINT "SourcingRequest_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: SourcingRequest SourcingRequest_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SourcingRequest"
    ADD CONSTRAINT "SourcingRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: SourcingRequest SourcingRequest_submittedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SourcingRequest"
    ADD CONSTRAINT "SourcingRequest_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: SupportMessage SupportMessage_ticketId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SupportMessage"
    ADD CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES public."SupportTicket"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: SupportTicket SupportTicket_submittedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SupportTicket"
    ADD CONSTRAINT "SupportTicket_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: WikiArticle WikiArticle_authorId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WikiArticle"
    ADD CONSTRAINT "WikiArticle_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: WishlistItem WishlistItem_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WishlistItem"
    ADD CONSTRAINT "WishlistItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: WishlistItem WishlistItem_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WishlistItem"
    ADD CONSTRAINT "WishlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: user user_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT "user_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


