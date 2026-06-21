-- Katsu Road (돈가스로드) - Supabase SQL Schema Setup

-- 1. Create PROFILES Table
CREATE TABLE public.profiles (
    id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    nickname TEXT,
    role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS on Profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Profiles Policies
CREATE POLICY "Public profiles are viewable by everyone" ON public.profiles
    FOR SELECT USING (true);

CREATE POLICY "Users can update their own profile" ON public.profiles
    FOR UPDATE USING (auth.uid() = id);


-- 2. Create RESTAURANTS Table
CREATE TABLE public.restaurants (
    id UUID DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    phone TEXT,
    business_hours TEXT,
    main_menu TEXT,
    category TEXT CHECK (category IN ('japanese', 'korean')),
    price_range TEXT CHECK (price_range IN ('10k_less', '10k_20k', '20k_more')),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    avg_rating NUMERIC(3,2) DEFAULT 0.00,
    review_count INTEGER DEFAULT 0,
    image_url TEXT,
    approved BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS on Restaurants
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;

-- Restaurants Policies
CREATE POLICY "Approved restaurants are viewable by everyone" ON public.restaurants
    FOR SELECT USING (approved = true OR (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "Authenticated users can insert new restaurants" ON public.restaurants
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Admins can update restaurants" ON public.restaurants
    FOR UPDATE USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "Admins can delete restaurants" ON public.restaurants
    FOR DELETE USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');


-- 3. Create REVIEWS Table
CREATE TABLE public.reviews (
    id UUID DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    restaurant_id UUID REFERENCES public.restaurants ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES public.profiles ON DELETE CASCADE NOT NULL,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5) NOT NULL,
    content TEXT NOT NULL,
    image_url TEXT,
    is_reported BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS on Reviews
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

-- Reviews Policies
CREATE POLICY "Reviews are viewable by everyone" ON public.reviews
    FOR SELECT USING (true);

CREATE POLICY "Authenticated users can write reviews" ON public.reviews
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own reviews" ON public.reviews
    FOR UPDATE USING (auth.uid() = user_id OR (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "Users can delete their own reviews" ON public.reviews
    FOR DELETE USING (auth.uid() = user_id OR (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');


-- 4. Create BOOKMARKS Table
CREATE TABLE public.bookmarks (
    id UUID DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id UUID REFERENCES public.profiles ON DELETE CASCADE NOT NULL,
    restaurant_id UUID REFERENCES public.restaurants ON DELETE CASCADE NOT NULL,
    is_visited BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, restaurant_id)
);

-- Enable RLS on Bookmarks
ALTER TABLE public.bookmarks ENABLE ROW LEVEL SECURITY;

-- Bookmarks Policies
CREATE POLICY "Users can view their own bookmarks" ON public.bookmarks
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own bookmarks" ON public.bookmarks
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own bookmarks" ON public.bookmarks
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own bookmarks" ON public.bookmarks
    FOR DELETE USING (auth.uid() = user_id);


-- 5. Automate User Profile Synchronization upon Signup
-- Create a function that handles new registered users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, nickname, role)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'nickname', split_part(new.email, '@', 1)),
    'user'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger the function every time a new auth.users record is created
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- 6. Trigger to Update Restaurant Average Rating & Review Count
CREATE OR REPLACE FUNCTION public.calculate_restaurant_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_restaurant_id UUID;
    v_avg_rating NUMERIC(3,2);
    v_review_count INT;
BEGIN
    -- Determine which restaurant ID to recalculate
    IF TG_OP = 'DELETE' THEN
        v_restaurant_id := OLD.restaurant_id;
    ELSE
        v_restaurant_id := NEW.restaurant_id;
    END IF;

    -- Calculate stats
    SELECT COALESCE(AVG(rating), 0.00), COUNT(*)
    INTO v_avg_rating, v_review_count
    FROM public.reviews
    WHERE restaurant_id = v_restaurant_id;

    -- Update restaurant
    UPDATE public.restaurants
    SET avg_rating = v_avg_rating,
        review_count = v_review_count
    WHERE id = v_restaurant_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create review triggers for INSERT, UPDATE, and DELETE
CREATE TRIGGER on_review_changed
  AFTER INSERT OR UPDATE OR DELETE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.calculate_restaurant_stats();
