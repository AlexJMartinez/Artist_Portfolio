# Overview

This is a full-stack Single Page Application (SPA) for artist Alex Martínez's portfolio website. The application allows visitors to view the artist's work and subscribe for updates, while providing an admin interface for portfolio management. The site features automatic email notifications to subscribers when new artwork is uploaded, creating an engaged community around the artist's work.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Single Page Application (SPA)**: Built with vanilla JavaScript and HTML, using client-side routing to navigate between Home, About, Portfolio, Development, Contact, and Login sections
- **Styling Framework**: PicoCSS for clean, minimal design with custom CSS animations
- **Interactive Elements**: Font Awesome icons for UI elements
- **Authentication State**: Client-side token management for admin login sessions
- **Portfolio Performance**: Skeleton shimmer loading screen, IntersectionObserver for progressive image loading (data-src → src), video click-to-load placeholders to avoid downloading large MP4s upfront
- **Portfolio Categories**: Portfolio page is split into two grids — "Photography" (default) and "Audio Visual". Items without a category are shown in Photography. Admins pick a category from a dropdown when uploading.

## Backend Architecture
- **Express.js Server**: RESTful API endpoints for portfolio management, file uploads, authentication, and subscriber management
- **File Storage**: Local filesystem storage with organized directory structure (`uploads/about/`, `uploads/portfolio/`, `uploads/shop/`)
- **Authentication**: Simple token-based authentication with hardcoded admin credentials (`Martin3z` / `May2nd1989`)
- **File Upload Handling**: Multer middleware for processing multipart form data and file uploads with automatic filename generation

## Data Storage
- **Replit Database**: Primary storage for subscriber information and persistent data
- **JSON Files**: Local JSON files for storing portfolio items and about section data (`about.json`, `portfolio.json`)
- **File System**: Direct file storage for uploaded images with timestamp-based naming

## Email System
- **Nodemailer Integration**: SMTP-based email service for sending notifications to subscribers
- **Automatic Notifications**: Triggered when new portfolio items are uploaded, keeping subscribers engaged with fresh content

# External Dependencies

## Core Frameworks
- **Express.js**: Web application framework for Node.js backend
- **PicoCSS**: Minimal CSS framework for responsive design
- **GSAP**: Animation library for smooth transitions and effects (loaded on-demand)

## File Handling
- **Multer**: Multipart form data handling for file uploads
- **Sharp**: Server-side image compression — resizes uploads to max 1400px wide at JPEG quality 82. Runs on every image upload and was used to retroactively compress existing large files.
- **Express-fileupload**: Alternative file upload middleware

## Authentication & Security
- **JSON Web Tokens (jsonwebtoken)**: Token-based authentication system
- **dotenv**: Environment variable management for secure configuration

## Data & Communication
- **@replit/database**: Replit's built-in database service for data persistence
- **Nodemailer**: Email sending functionality for subscriber notifications
- **node-fetch**: HTTP client for external API requests
- **QuickMongo**: MongoDB integration option for advanced data needs

## Development Tools
- **Font Awesome**: Icon library for UI elements
- **CDN Resources**: External CDN links for PicoCSS, Font Awesome, GSAP, and PIXI.js

The architecture prioritizes simplicity and rapid development while maintaining clean separation between frontend presentation, backend API logic, and data persistence layers.