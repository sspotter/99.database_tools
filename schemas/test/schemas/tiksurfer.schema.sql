--
-- PostgreSQL database dump
--

\restrict 6rEjAoEsSw64kZ8vZanPq4hYFnpXZeoNCSN3gFB6u8TVh4CskhcOR8WyXLLY4ro

-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: comment_scrape_logs; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.comment_scrape_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    post_shortcode character varying(255),
    api_calls integer DEFAULT 0,
    comments_scraped integer DEFAULT 0,
    scraped_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.comment_scrape_logs OWNER TO devuser;

--
-- Name: comments; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.comments (
    id character varying(255) NOT NULL,
    post_shortcode character varying(255) NOT NULL,
    username character varying(255),
    user_id character varying(255),
    text text,
    likes_count integer DEFAULT 0,
    reply_count integer DEFAULT 0,
    profile_pic_url text,
    commented_at timestamp with time zone,
    scraped_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.comments OWNER TO devuser;

--
-- Name: ig_users; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.ig_users (
    id character varying(255) NOT NULL,
    username character varying(255) NOT NULL,
    follower_count bigint DEFAULT 0,
    following_count bigint DEFAULT 0,
    media_count integer DEFAULT 0,
    biography text,
    external_url text,
    business_category character varying(255),
    is_verified boolean DEFAULT false,
    role character varying(50) DEFAULT 'reference'::character varying,
    scraped_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.ig_users OWNER TO devuser;

--
-- Name: post_metrics_history; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.post_metrics_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_shortcode character varying(255),
    likes_count integer DEFAULT 0,
    comments_count integer DEFAULT 0,
    video_view_count integer DEFAULT 0,
    view_count bigint DEFAULT 0,
    repost_count integer DEFAULT 0,
    share_count integer DEFAULT 0,
    bookmark_count integer DEFAULT 0,
    captured_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.post_metrics_history OWNER TO devuser;

--
-- Name: post_relations; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.post_relations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_shortcode character varying(255),
    username character varying(255),
    relation_type character varying(50) NOT NULL
);


ALTER TABLE public.post_relations OWNER TO devuser;

--
-- Name: posts; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.posts (
    shortcode character varying(255) NOT NULL,
    owner_username character varying(255),
    post_url text,
    caption text,
    image_url text,
    video_url text,
    is_video boolean DEFAULT false,
    is_carousel boolean DEFAULT false,
    is_paid boolean DEFAULT false,
    classification character varying(100) DEFAULT 'Normal Post'::character varying,
    type character varying(50) DEFAULT 'normal'::character varying,
    collective_reach bigint DEFAULT 0,
    reach_breakdown jsonb DEFAULT '[]'::jsonb,
    scraped_from_profile character varying(255),
    is_reference boolean DEFAULT false,
    view_count bigint DEFAULT 0,
    repost_count integer DEFAULT 0,
    share_count integer DEFAULT 0,
    bookmark_count integer DEFAULT 0,
    posted_at timestamp with time zone,
    first_captured_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    last_updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.posts OWNER TO devuser;

--
-- Name: project_posts; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.project_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    post_shortcode character varying(255) NOT NULL,
    added_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.project_posts OWNER TO devuser;

--
-- Name: project_profiles; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.project_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    username character varying(255) NOT NULL,
    role character varying(50) DEFAULT 'tracked'::character varying,
    added_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    pinned boolean DEFAULT false
);


ALTER TABLE public.project_profiles OWNER TO devuser;

--
-- Name: projects; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.projects OWNER TO devuser;

--
-- Name: scrape_jobs; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.scrape_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    post_shortcode character varying(255) NOT NULL,
    page_number integer DEFAULT 1,
    status character varying(50) DEFAULT 'pending'::character varying,
    end_cursor text DEFAULT ''::text,
    comments_scraped integer DEFAULT 0,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    error_message text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp with time zone,
    completed_at timestamp with time zone
);


ALTER TABLE public.scrape_jobs OWNER TO devuser;

--
-- Name: scrape_sessions; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.scrape_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    profile_username character varying(255),
    status character varying(50) DEFAULT 'pending'::character varying,
    total_posts integer DEFAULT 0,
    total_jobs integer DEFAULT 0,
    completed_jobs integer DEFAULT 0,
    total_comments_scraped integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    project_id uuid
);


ALTER TABLE public.scrape_sessions OWNER TO devuser;

--
-- Name: user_scraped_posts; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.user_scraped_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    post_shortcode character varying(255),
    scraped_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.user_scraped_posts OWNER TO devuser;

--
-- Name: users; Type: TABLE; Schema: public; Owner: devuser
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying,
    plan character varying(50) DEFAULT 'none'::character varying,
    active_sessions integer DEFAULT 0,
    last_login timestamp with time zone,
    max_devices integer DEFAULT 3,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.users OWNER TO devuser;

--
-- Name: comment_scrape_logs comment_scrape_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.comment_scrape_logs
    ADD CONSTRAINT comment_scrape_logs_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: ig_users ig_users_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.ig_users
    ADD CONSTRAINT ig_users_pkey PRIMARY KEY (id);


--
-- Name: ig_users ig_users_username_key; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.ig_users
    ADD CONSTRAINT ig_users_username_key UNIQUE (username);


--
-- Name: post_metrics_history post_metrics_history_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.post_metrics_history
    ADD CONSTRAINT post_metrics_history_pkey PRIMARY KEY (id);


--
-- Name: post_relations post_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.post_relations
    ADD CONSTRAINT post_relations_pkey PRIMARY KEY (id);


--
-- Name: posts posts_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_pkey PRIMARY KEY (shortcode);


--
-- Name: project_posts project_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.project_posts
    ADD CONSTRAINT project_posts_pkey PRIMARY KEY (id);


--
-- Name: project_posts project_posts_project_id_post_shortcode_key; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.project_posts
    ADD CONSTRAINT project_posts_project_id_post_shortcode_key UNIQUE (project_id, post_shortcode);


--
-- Name: project_profiles project_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.project_profiles
    ADD CONSTRAINT project_profiles_pkey PRIMARY KEY (id);


--
-- Name: project_profiles project_profiles_project_id_username_key; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.project_profiles
    ADD CONSTRAINT project_profiles_project_id_username_key UNIQUE (project_id, username);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: scrape_jobs scrape_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.scrape_jobs
    ADD CONSTRAINT scrape_jobs_pkey PRIMARY KEY (id);


--
-- Name: scrape_sessions scrape_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.scrape_sessions
    ADD CONSTRAINT scrape_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_scraped_posts user_scraped_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.user_scraped_posts
    ADD CONSTRAINT user_scraped_posts_pkey PRIMARY KEY (id);


--
-- Name: user_scraped_posts user_scraped_posts_user_id_post_shortcode_key; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.user_scraped_posts
    ADD CONSTRAINT user_scraped_posts_user_id_post_shortcode_key UNIQUE (user_id, post_shortcode);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_comment_scrape_logs_post; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_comment_scrape_logs_post ON public.comment_scrape_logs USING btree (post_shortcode);


--
-- Name: idx_comments_post; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_comments_post ON public.comments USING btree (post_shortcode);


--
-- Name: idx_comments_username; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_comments_username ON public.comments USING btree (username);


--
-- Name: idx_metrics_post; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_metrics_post ON public.post_metrics_history USING btree (post_shortcode);


--
-- Name: idx_posts_owner; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_posts_owner ON public.posts USING btree (owner_username);


--
-- Name: idx_posts_type; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_posts_type ON public.posts USING btree (type);


--
-- Name: idx_project_posts_post; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_project_posts_post ON public.project_posts USING btree (post_shortcode);


--
-- Name: idx_project_posts_project; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_project_posts_project ON public.project_posts USING btree (project_id);


--
-- Name: idx_project_profiles_project; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_project_profiles_project ON public.project_profiles USING btree (project_id);


--
-- Name: idx_project_profiles_username; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_project_profiles_username ON public.project_profiles USING btree (username);


--
-- Name: idx_projects_user; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_projects_user ON public.projects USING btree (user_id);


--
-- Name: idx_relations_post; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_relations_post ON public.post_relations USING btree (post_shortcode);


--
-- Name: idx_relations_user; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_relations_user ON public.post_relations USING btree (username);


--
-- Name: idx_scrape_jobs_post; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_scrape_jobs_post ON public.scrape_jobs USING btree (post_shortcode);


--
-- Name: idx_scrape_jobs_session; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_scrape_jobs_session ON public.scrape_jobs USING btree (session_id);


--
-- Name: idx_scrape_jobs_status; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_scrape_jobs_status ON public.scrape_jobs USING btree (status);


--
-- Name: idx_scrape_sessions_project; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_scrape_sessions_project ON public.scrape_sessions USING btree (project_id);


--
-- Name: idx_scrape_sessions_status; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_scrape_sessions_status ON public.scrape_sessions USING btree (status);


--
-- Name: idx_scrape_sessions_user; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_scrape_sessions_user ON public.scrape_sessions USING btree (user_id);


--
-- Name: idx_user_scraped_posts_post; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_user_scraped_posts_post ON public.user_scraped_posts USING btree (post_shortcode);


--
-- Name: idx_user_scraped_posts_user; Type: INDEX; Schema: public; Owner: devuser
--

CREATE INDEX idx_user_scraped_posts_user ON public.user_scraped_posts USING btree (user_id);


--
-- Name: comment_scrape_logs comment_scrape_logs_post_shortcode_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.comment_scrape_logs
    ADD CONSTRAINT comment_scrape_logs_post_shortcode_fkey FOREIGN KEY (post_shortcode) REFERENCES public.posts(shortcode) ON DELETE CASCADE;


--
-- Name: comment_scrape_logs comment_scrape_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.comment_scrape_logs
    ADD CONSTRAINT comment_scrape_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: comments comments_post_shortcode_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_post_shortcode_fkey FOREIGN KEY (post_shortcode) REFERENCES public.posts(shortcode) ON DELETE CASCADE;


--
-- Name: post_metrics_history post_metrics_history_post_shortcode_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.post_metrics_history
    ADD CONSTRAINT post_metrics_history_post_shortcode_fkey FOREIGN KEY (post_shortcode) REFERENCES public.posts(shortcode) ON DELETE CASCADE;


--
-- Name: post_relations post_relations_post_shortcode_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.post_relations
    ADD CONSTRAINT post_relations_post_shortcode_fkey FOREIGN KEY (post_shortcode) REFERENCES public.posts(shortcode) ON DELETE CASCADE;


--
-- Name: post_relations post_relations_username_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.post_relations
    ADD CONSTRAINT post_relations_username_fkey FOREIGN KEY (username) REFERENCES public.ig_users(username) ON DELETE CASCADE;


--
-- Name: posts posts_owner_username_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_owner_username_fkey FOREIGN KEY (owner_username) REFERENCES public.ig_users(username) ON DELETE CASCADE;


--
-- Name: project_posts project_posts_post_shortcode_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.project_posts
    ADD CONSTRAINT project_posts_post_shortcode_fkey FOREIGN KEY (post_shortcode) REFERENCES public.posts(shortcode) ON DELETE CASCADE;


--
-- Name: project_posts project_posts_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.project_posts
    ADD CONSTRAINT project_posts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_profiles project_profiles_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.project_profiles
    ADD CONSTRAINT project_profiles_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_profiles project_profiles_username_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.project_profiles
    ADD CONSTRAINT project_profiles_username_fkey FOREIGN KEY (username) REFERENCES public.ig_users(username) ON DELETE CASCADE;


--
-- Name: projects projects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: scrape_jobs scrape_jobs_post_shortcode_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.scrape_jobs
    ADD CONSTRAINT scrape_jobs_post_shortcode_fkey FOREIGN KEY (post_shortcode) REFERENCES public.posts(shortcode) ON DELETE CASCADE;


--
-- Name: scrape_jobs scrape_jobs_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.scrape_jobs
    ADD CONSTRAINT scrape_jobs_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.scrape_sessions(id) ON DELETE CASCADE;


--
-- Name: scrape_sessions scrape_sessions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.scrape_sessions
    ADD CONSTRAINT scrape_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: scrape_sessions scrape_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.scrape_sessions
    ADD CONSTRAINT scrape_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_scraped_posts user_scraped_posts_post_shortcode_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.user_scraped_posts
    ADD CONSTRAINT user_scraped_posts_post_shortcode_fkey FOREIGN KEY (post_shortcode) REFERENCES public.posts(shortcode) ON DELETE CASCADE;


--
-- Name: user_scraped_posts user_scraped_posts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: devuser
--

ALTER TABLE ONLY public.user_scraped_posts
    ADD CONSTRAINT user_scraped_posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



--
-- TikSurfur V3 keyword intelligence tables
--

CREATE TABLE IF NOT EXISTS public.search_keywords (
    id                  uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id          uuid NOT NULL,
    keyword             varchar(255) NOT NULL,
    platform            varchar(50) DEFAULT 'tiktok' NOT NULL,
    status              varchar(50) DEFAULT 'active' NOT NULL,
    total_videos        integer DEFAULT 0,
    total_creators      integer DEFAULT 0,
    total_views         bigint  DEFAULT 0,
    total_engagement    bigint  DEFAULT 0,
    created_at          timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at          timestamptz DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT search_keywords_pkey PRIMARY KEY (id),
    CONSTRAINT search_keywords_project_keyword_unique UNIQUE (project_id, keyword),
    CONSTRAINT search_keywords_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT search_keywords_status_check
        CHECK (status IN ('active', 'paused', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_search_keywords_project
    ON public.search_keywords USING btree (project_id);

CREATE INDEX IF NOT EXISTS idx_search_keywords_keyword
    ON public.search_keywords USING btree (keyword);

CREATE TABLE IF NOT EXISTS public.keyword_search_sessions (
    id               uuid DEFAULT gen_random_uuid() NOT NULL,
    keyword_id       uuid NOT NULL,
    project_id       uuid NOT NULL,
    status           varchar(50) DEFAULT 'active' NOT NULL,
    videos_captured  integer DEFAULT 0,
    scroll_position  integer DEFAULT 0,
    started_at       timestamptz DEFAULT CURRENT_TIMESTAMP,
    ended_at         timestamptz,
    created_at       timestamptz DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT keyword_search_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT keyword_search_sessions_keyword_id_fkey
        FOREIGN KEY (keyword_id) REFERENCES public.search_keywords(id) ON DELETE CASCADE,
    CONSTRAINT keyword_search_sessions_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT keyword_search_sessions_status_check
        CHECK (status IN ('active', 'paused', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_kw_sessions_keyword
    ON public.keyword_search_sessions USING btree (keyword_id);

CREATE INDEX IF NOT EXISTS idx_kw_sessions_project
    ON public.keyword_search_sessions USING btree (project_id);

CREATE INDEX IF NOT EXISTS idx_kw_sessions_status
    ON public.keyword_search_sessions USING btree (status);

CREATE TABLE IF NOT EXISTS public.tiktok_creators (
    id               uuid DEFAULT gen_random_uuid() NOT NULL,
    tiktok_user_id   varchar(255) NOT NULL,
    username         varchar(255) NOT NULL,
    display_name     varchar(255),
    avatar_url       text,
    follower_count   bigint  DEFAULT 0,
    following_count  integer DEFAULT 0,
    video_count      integer DEFAULT 0,
    biography        text,
    is_verified      boolean DEFAULT false,
    first_seen_at    timestamptz DEFAULT CURRENT_TIMESTAMP,
    last_updated_at  timestamptz DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tiktok_creators_pkey PRIMARY KEY (id),
    CONSTRAINT tiktok_creators_tiktok_user_id_unique UNIQUE (tiktok_user_id),
    CONSTRAINT tiktok_creators_username_unique UNIQUE (username)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_creators_username
    ON public.tiktok_creators USING btree (username);

CREATE TABLE IF NOT EXISTS public.tiktok_videos (
    id                      uuid DEFAULT gen_random_uuid() NOT NULL,
    video_id                varchar(255) NOT NULL,
    keyword_id              uuid NOT NULL,
    session_id              uuid,
    creator_id              uuid,
    project_id              uuid NOT NULL,
    caption                 text,
    video_url               text,
    thumbnail_url           text,
    duration                integer DEFAULT 0,
    views_count             bigint  DEFAULT 0,
    likes_count             bigint  DEFAULT 0,
    comments_count          integer DEFAULT 0,
    shares_count            integer DEFAULT 0,
    bookmarks_count         integer DEFAULT 0,
    included_in_reach       boolean DEFAULT true,
    included_in_engagement  boolean DEFAULT true,
    included_in_reporting   boolean DEFAULT true,
    manual_reviewed         boolean DEFAULT false,
    relevance_score         integer DEFAULT 0 CHECK (relevance_score BETWEEN 0 AND 100),
    capture_status          varchar(50) DEFAULT 'captured' NOT NULL,
    posted_at               timestamptz,
    captured_at             timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at              timestamptz DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tiktok_videos_pkey PRIMARY KEY (id),
    CONSTRAINT tiktok_videos_video_keyword_unique UNIQUE (video_id, keyword_id),
    CONSTRAINT tiktok_videos_keyword_id_fkey
        FOREIGN KEY (keyword_id) REFERENCES public.search_keywords(id) ON DELETE CASCADE,
    CONSTRAINT tiktok_videos_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES public.keyword_search_sessions(id) ON DELETE SET NULL,
    CONSTRAINT tiktok_videos_creator_id_fkey
        FOREIGN KEY (creator_id) REFERENCES public.tiktok_creators(id) ON DELETE SET NULL,
    CONSTRAINT tiktok_videos_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT tiktok_videos_capture_status_check
        CHECK (capture_status IN ('captured', 'comments_pending', 'comments_partial', 'comments_done', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_keyword
    ON public.tiktok_videos USING btree (keyword_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_session
    ON public.tiktok_videos USING btree (session_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_creator
    ON public.tiktok_videos USING btree (creator_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_project
    ON public.tiktok_videos USING btree (project_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_capture_status
    ON public.tiktok_videos USING btree (capture_status);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_included_reach
    ON public.tiktok_videos USING btree (included_in_reach);

CREATE TABLE IF NOT EXISTS public.tiktok_comments (
    id                    varchar(255) NOT NULL,
    video_id              varchar(255) NOT NULL,
    keyword_id            uuid,
    commenter_username    varchar(255),
    commenter_user_id     varchar(255),
    commenter_avatar_url  text,
    text                  text,
    likes_count           integer DEFAULT 0,
    reply_count           integer DEFAULT 0,
    is_reply              boolean DEFAULT false,
    parent_comment_id     varchar(255),
    commented_at          timestamptz,
    scraped_at            timestamptz DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tiktok_comments_pkey PRIMARY KEY (id),
    CONSTRAINT tiktok_comments_keyword_id_fkey
        FOREIGN KEY (keyword_id) REFERENCES public.search_keywords(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tiktok_comments_video
    ON public.tiktok_comments USING btree (video_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_comments_keyword
    ON public.tiktok_comments USING btree (keyword_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_comments_username
    ON public.tiktok_comments USING btree (commenter_username);

CREATE TABLE IF NOT EXISTS public.tiktok_hashtags (
    id          uuid DEFAULT gen_random_uuid() NOT NULL,
    video_id    varchar(255) NOT NULL,
    keyword_id  uuid,
    tag         varchar(255) NOT NULL,
    view_count  bigint DEFAULT 0,

    CONSTRAINT tiktok_hashtags_pkey PRIMARY KEY (id),
    CONSTRAINT tiktok_hashtags_video_tag_unique UNIQUE (video_id, tag),
    CONSTRAINT tiktok_hashtags_keyword_id_fkey
        FOREIGN KEY (keyword_id) REFERENCES public.search_keywords(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tiktok_hashtags_video
    ON public.tiktok_hashtags USING btree (video_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_hashtags_keyword
    ON public.tiktok_hashtags USING btree (keyword_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_hashtags_tag
    ON public.tiktok_hashtags USING btree (tag);

CREATE TABLE IF NOT EXISTS public.tiktok_graphql_captures (
    id             uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id     uuid,
    keyword_id     uuid,
    video_id       varchar(255),
    creator_id     uuid,
    url            text NOT NULL,
    method         varchar(10) DEFAULT 'GET',
    capture_type   varchar(50) DEFAULT 'unknown',
    request_body   jsonb,
    response_body  jsonb,
    captured_at    timestamptz DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tiktok_graphql_captures_pkey PRIMARY KEY (id),
    CONSTRAINT tiktok_graphql_captures_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES public.keyword_search_sessions(id) ON DELETE SET NULL,
    CONSTRAINT tiktok_graphql_captures_keyword_id_fkey
        FOREIGN KEY (keyword_id) REFERENCES public.search_keywords(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_graphql_captures_session
    ON public.tiktok_graphql_captures USING btree (session_id);

CREATE INDEX IF NOT EXISTS idx_graphql_captures_keyword
    ON public.tiktok_graphql_captures USING btree (keyword_id);

CREATE INDEX IF NOT EXISTS idx_graphql_captures_video
    ON public.tiktok_graphql_captures USING btree (video_id);

CREATE INDEX IF NOT EXISTS idx_graphql_captures_type
    ON public.tiktok_graphql_captures USING btree (capture_type);

CREATE TABLE IF NOT EXISTS public.tiktok_keyword_creators (
    id            uuid DEFAULT gen_random_uuid() NOT NULL,
    keyword_id    uuid NOT NULL,
    creator_id    uuid NOT NULL,
    video_count   integer DEFAULT 1,
    total_views   bigint  DEFAULT 0,
    first_seen_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  timestamptz DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tiktok_keyword_creators_pkey PRIMARY KEY (id),
    CONSTRAINT tiktok_keyword_creators_unique UNIQUE (keyword_id, creator_id),
    CONSTRAINT tiktok_keyword_creators_keyword_fkey
        FOREIGN KEY (keyword_id) REFERENCES public.search_keywords(id) ON DELETE CASCADE,
    CONSTRAINT tiktok_keyword_creators_creator_fkey
        FOREIGN KEY (creator_id) REFERENCES public.tiktok_creators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kw_creators_keyword
    ON public.tiktok_keyword_creators USING btree (keyword_id);

CREATE INDEX IF NOT EXISTS idx_kw_creators_creator
    ON public.tiktok_keyword_creators USING btree (creator_id);

--
-- PostgreSQL database dump complete
--

\unrestrict 6rEjAoEsSw64kZ8vZanPq4hYFnpXZeoNCSN3gFB6u8TVh4CskhcOR8WyXLLY4ro


