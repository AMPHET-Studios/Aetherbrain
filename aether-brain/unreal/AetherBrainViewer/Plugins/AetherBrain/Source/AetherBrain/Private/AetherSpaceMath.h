// The maths behind the viewer's space world (AetherSpaceActor): procedural nebula, galaxy and star pictures, how far
// a backdrop layer slides for parallax, where asteroids, shooting stars and alien ships are at any moment, and what
// the ships are made of.
//
// Plain C++ with no Unreal types, so it is compiled and tested on an ordinary computer
// (unreal/tests/space_core_test.cpp, unreal/tests/space_preview.cpp renders a picture of it) and the actor only turns
// its answers into transforms. Every moving thing is a pure function of time, so nothing needs saving, respawning
// or synchronising.
//
// Axes are Unreal's: X forward, Y right, Z up. Lengths are cm. A Quat is (X, Y, Z, W) and rotates like Unreal's FQuat
// (the same numbers rotate the same way); `A * B` applies B first, then A.
#pragma once

#include <cmath>
#include <cstdint>
#include <vector>

namespace AetherSpace
{
constexpr double kPi = 3.14159265358979323846;

/** The brain's radius the motion is laid out for; a bigger brain widens the scene around it (see FieldRadius). */
constexpr double kNominalField = 6000.0;

inline double Clamp(double V, double Lo, double Hi) { return V < Lo ? Lo : (V > Hi ? Hi : V); }
inline double Clamp01(double V) { return Clamp(V, 0.0, 1.0); }
inline double Lerp(double A, double B, double T) { return A + (B - A) * T; }
inline double DegToRad(double D) { return D * (kPi / 180.0); }

/** 0 at E0, 1 at E1, smooth between (E0 may be above E1). */
inline double Smoothstep(double E0, double E1, double X)
{
	const double T = Clamp01((X - E0) / (E1 - E0));
	return T * T * (3.0 - 2.0 * T);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Vectors and rotations                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

struct Vec3
{
	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;
};

inline Vec3 operator+(const Vec3& A, const Vec3& B) { return {A.X + B.X, A.Y + B.Y, A.Z + B.Z}; }
inline Vec3 operator-(const Vec3& A, const Vec3& B) { return {A.X - B.X, A.Y - B.Y, A.Z - B.Z}; }
inline Vec3 operator*(const Vec3& A, double S) { return {A.X * S, A.Y * S, A.Z * S}; }
inline Vec3 operator*(double S, const Vec3& A) { return {A.X * S, A.Y * S, A.Z * S}; }
inline Vec3 operator-(const Vec3& A) { return {-A.X, -A.Y, -A.Z}; }
inline double Dot(const Vec3& A, const Vec3& B) { return A.X * B.X + A.Y * B.Y + A.Z * B.Z; }
inline Vec3 Cross(const Vec3& A, const Vec3& B) { return {A.Y * B.Z - A.Z * B.Y, A.Z * B.X - A.X * B.Z, A.X * B.Y - A.Y * B.X}; }
inline double Length(const Vec3& A) { return std::sqrt(Dot(A, A)); }

inline Vec3 Normalized(const Vec3& A, const Vec3& Fallback = Vec3{0.0, 0.0, 1.0})
{
	const double L = Length(A);
	return L > 1e-12 ? A * (1.0 / L) : Fallback;
}

constexpr Vec3 kUp{0.0, 0.0, 1.0};

struct Quat
{
	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;
	double W = 1.0;
};

/** Applies B first, then A. */
inline Quat operator*(const Quat& A, const Quat& B)
{
	return {A.W * B.X + A.X * B.W + A.Y * B.Z - A.Z * B.Y, A.W * B.Y - A.X * B.Z + A.Y * B.W + A.Z * B.X,
		A.W * B.Z + A.X * B.Y - A.Y * B.X + A.Z * B.W, A.W * B.W - A.X * B.X - A.Y * B.Y - A.Z * B.Z};
}

inline Quat FromAxisAngle(const Vec3& Axis, double Angle)
{
	const Vec3 A = Normalized(Axis);
	const double S = std::sin(Angle * 0.5);
	return {A.X * S, A.Y * S, A.Z * S, std::cos(Angle * 0.5)};
}

inline Vec3 Rotate(const Quat& Q, const Vec3& V)
{
	const Vec3 Qv{Q.X, Q.Y, Q.Z};
	const Vec3 T = Cross(Qv, V) * 2.0;
	return V + T * Q.W + Cross(Qv, T);
}

/** The rotation whose columns are the three (orthonormal) axes: it turns +X into X, +Y into Y and +Z into Z. */
inline Quat FromBasis(const Vec3& X, const Vec3& Y, const Vec3& Z)
{
	const double M00 = X.X;
	const double M01 = Y.X;
	const double M02 = Z.X;
	const double M10 = X.Y;
	const double M11 = Y.Y;
	const double M12 = Z.Y;
	const double M20 = X.Z;
	const double M21 = Y.Z;
	const double M22 = Z.Z;
	const double Trace = M00 + M11 + M22;
	Quat Q;
	if (Trace > 0.0)
	{
		const double S = std::sqrt(Trace + 1.0) * 2.0;
		Q = {(M21 - M12) / S, (M02 - M20) / S, (M10 - M01) / S, 0.25 * S};
	}
	else if (M00 > M11 && M00 > M22)
	{
		const double S = std::sqrt(1.0 + M00 - M11 - M22) * 2.0;
		Q = {0.25 * S, (M01 + M10) / S, (M02 + M20) / S, (M21 - M12) / S};
	}
	else if (M11 > M22)
	{
		const double S = std::sqrt(1.0 + M11 - M00 - M22) * 2.0;
		Q = {(M01 + M10) / S, 0.25 * S, (M12 + M21) / S, (M02 - M20) / S};
	}
	else
	{
		const double S = std::sqrt(1.0 + M22 - M00 - M11) * 2.0;
		Q = {(M02 + M20) / S, (M12 + M21) / S, 0.25 * S, (M10 - M01) / S};
	}
	const double N = std::sqrt(Q.X * Q.X + Q.Y * Q.Y + Q.Z * Q.Z + Q.W * Q.W);
	return {Q.X / N, Q.Y / N, Q.Z / N, Q.W / N};
}

/**
 * The shortest turn that takes +Z to Dir: how a cylinder or a cone is pointed along a direction, and a plane is made
 * to face one. +Z itself is no turn at all (so a part pointing up keeps its axes), -Z is a half turn about X.
 */
inline Quat FromZTo(const Vec3& Dir)
{
	const Vec3 Z = Normalized(Dir);
	if (Z.Z < -0.999999)
	{
		return {1.0, 0.0, 0.0, 0.0};
	}
	// (+Z) x Z is the axis, 1 + (+Z) . Z the half-angle terms of the shortest arc.
	const Quat Q{-Z.Y, Z.X, 0.0, 1.0 + Z.Z};
	const double N = std::sqrt(Q.X * Q.X + Q.Y * Q.Y + Q.Z * Q.Z + Q.W * Q.W);
	return {Q.X / N, Q.Y / N, Q.Z / N, Q.W / N};
}

/** The rotation that turns +X into Forward and keeps +Z as near Up as it can. */
inline Quat LookRotation(const Vec3& Forward, const Vec3& Up = kUp)
{
	const Vec3 X = Normalized(Forward, Vec3{1.0, 0.0, 0.0});
	Vec3 Side = Cross(Up, X);
	if (Length(Side) < 1e-6)
	{
		Side = Cross(Vec3{1.0, 0.0, 0.0}, X);
		if (Length(Side) < 1e-6)
		{
			Side = Cross(Vec3{0.0, 1.0, 0.0}, X);
		}
	}
	const Vec3 Y = Normalized(Side);
	return FromBasis(X, Y, Cross(X, Y));
}

/** Where, how turned and how big (a multiple of the 100 cm engine mesh, per axis) something is drawn. */
struct Xf
{
	Vec3 Pos;
	Quat Rot;
	Vec3 Scale{1.0, 1.0, 1.0};
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Random numbers: seeded, and stateless hashes for things that are a pure function of time                          */
/* ------------------------------------------------------------------------------------------------------------------ */

inline uint32_t Mix(uint32_t H)
{
	H ^= H >> 16;
	H *= 0x7feb352dU;
	H ^= H >> 15;
	H *= 0x846ca68bU;
	H ^= H >> 16;
	return H;
}

inline uint32_t HashU(uint32_t A, uint32_t B = 0U, uint32_t C = 0U)
{
	return Mix((A * 0x9E3779B1U) ^ Mix(B + 0x85EBCA6BU) ^ Mix((C * 0xC2B2AE35U) + 0x27D4EB2FU));
}

/** In [0, 1). */
inline double Hash01(uint32_t A, uint32_t B = 0U, uint32_t C = 0U)
{
	return static_cast<double>(HashU(A, B, C) >> 8) * (1.0 / 16777216.0);
}

struct Rng
{
	uint32_t S;

	explicit Rng(uint32_t Seed) : S(Mix(Seed + 0x6D2B79F5U) | 1U) {}

	uint32_t NextU()
	{
		S ^= S << 13;
		S ^= S >> 17;
		S ^= S << 5;
		return S;
	}
	/** In [0, 1). */
	double Next() { return static_cast<double>(NextU() >> 8) * (1.0 / 16777216.0); }
	double Range(double A, double B) { return A + (B - A) * Next(); }
	bool Chance(double P) { return Next() < P; }
	/** Standard normal (Box-Muller). */
	double Gauss()
	{
		const double U1 = Next() + 1e-12;
		return std::sqrt(-2.0 * std::log(U1)) * std::cos(2.0 * kPi * Next());
	}
	/** Uniform on the unit sphere. */
	Vec3 Unit()
	{
		const double Z = Range(-1.0, 1.0);
		const double A = Range(0.0, 2.0 * kPi);
		const double R = std::sqrt(1.0 - Z * Z);
		return {R * std::cos(A), R * std::sin(A), Z};
	}
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Noise and the pictures made of it                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

inline double Lattice(int X, int Y, uint32_t Seed)
{
	return Hash01(static_cast<uint32_t>(X), static_cast<uint32_t>(Y), Seed);
}

/** Smooth value noise in [0, 1]. */
inline double ValueNoise(double X, double Y, uint32_t Seed)
{
	const double Fx = std::floor(X);
	const double Fy = std::floor(Y);
	const int Ix = static_cast<int>(Fx);
	const int Iy = static_cast<int>(Fy);
	double Tx = X - Fx;
	double Ty = Y - Fy;
	Tx = Tx * Tx * Tx * (Tx * (Tx * 6.0 - 15.0) + 10.0);
	Ty = Ty * Ty * Ty * (Ty * (Ty * 6.0 - 15.0) + 10.0);
	const double A = Lattice(Ix, Iy, Seed);
	const double B = Lattice(Ix + 1, Iy, Seed);
	const double C = Lattice(Ix, Iy + 1, Seed);
	const double D = Lattice(Ix + 1, Iy + 1, Seed);
	return Lerp(Lerp(A, B, Tx), Lerp(C, D, Tx), Ty);
}

/** Fractal noise in [0, 1]: each octave twice as fine, half as strong, and turned. */
inline double Fbm(double X, double Y, int Octaves, uint32_t Seed)
{
	double Sum = 0.0;
	double Amp = 0.5;
	double Norm = 0.0;
	for (int O = 0; O < Octaves; ++O)
	{
		Sum += Amp * ValueNoise(X, Y, Seed + static_cast<uint32_t>(O) * 101U);
		Norm += Amp;
		const double Nx = 1.6 * X - 1.2 * Y + 17.3;
		const double Ny = 1.2 * X + 1.6 * Y - 9.1;
		X = Nx;
		Y = Ny;
		Amp *= 0.5;
	}
	return Sum / Norm;
}

inline uint8_t ToSrgb8(double Linear)
{
	const double L = Clamp01(Linear);
	const double S = L <= 0.0031308 ? 12.92 * L : 1.055 * std::pow(L, 1.0 / 2.4) - 0.055;
	return static_cast<uint8_t>(S * 255.0 + 0.5);
}

inline double SrgbToLinear(uint8_t V)
{
	const double S = static_cast<double>(V) / 255.0;
	return S <= 0.04045 ? S / 12.92 : std::pow((S + 0.055) / 1.055, 2.4);
}

/** Pixels as Unreal's PF_B8G8R8A8 wants them (B, G, R, A); the values are sRGB, the texture is flagged sRGB. */
struct Image
{
	int Width = 0;
	int Height = 0;
	std::vector<uint8_t> Bgra;

	Image() = default;
	Image(int W, int H) : Width(W), Height(H), Bgra(static_cast<size_t>(W) * static_cast<size_t>(H) * 4U, 0) {}

	size_t Offset(int X, int Y) const { return (static_cast<size_t>(Y) * static_cast<size_t>(Width) + static_cast<size_t>(X)) * 4U; }

	/** Linear light in, soft-clipped so a bright core rolls off instead of blowing out. */
	void Put(int X, int Y, double R, double G, double B)
	{
		const size_t O = Offset(X, Y);
		Bgra[O + 0] = ToSrgb8(1.0 - std::exp(-1.5 * B));
		Bgra[O + 1] = ToSrgb8(1.0 - std::exp(-1.5 * G));
		Bgra[O + 2] = ToSrgb8(1.0 - std::exp(-1.5 * R));
		Bgra[O + 3] = 255;
	}

	/** Linear light of a pixel. */
	void Get(int X, int Y, double& R, double& G, double& B) const
	{
		const size_t O = Offset(X, Y);
		B = SrgbToLinear(Bgra[O + 0]);
		G = SrgbToLinear(Bgra[O + 1]);
		R = SrgbToLinear(Bgra[O + 2]);
	}
};

constexpr int kNebulaVariants = 4;
constexpr int kGalaxyVariants = 5;

/**
 * A cloud of gas and dust, lit from inside: a domain-warped fractal for the diffuse glow, ridged noise for thin
 * bright filaments, brighter pockets, dark dust lanes cut through it, and an irregular outline that fades to nothing
 * before the edge (so a sprite has no visible rectangle). The three colour channels differ only mildly: an instance's
 * tint chooses the mood, the picture adds variation within it.
 */
inline Image MakeNebula(int Size, uint32_t Seed)
{
	Image Img(Size, Size);
	const double Freq = 1.8 + 1.2 * Hash01(Seed, 7U);
	for (int Y = 0; Y < Size; ++Y)
	{
		for (int X = 0; X < Size; ++X)
		{
			const double U = (static_cast<double>(X) + 0.5) / static_cast<double>(Size) * 2.0 - 1.0;
			const double V = (static_cast<double>(Y) + 0.5) / static_cast<double>(Size) * 2.0 - 1.0;
			const double R = std::sqrt(U * U + V * V);
			const double Px = U * Freq;
			const double Py = V * Freq;
			const double Qx = Fbm(Px + 1.7, Py + 9.2, 4, Seed + 1U);
			const double Qy = Fbm(Px + 8.3, Py + 2.8, 4, Seed + 2U);
			const double Wx = Px + 4.2 * (Qx - 0.5);
			const double Wy = Py + 4.2 * (Qy - 0.5);
			const double D = Fbm(Wx, Wy, 6, Seed + 3U);
			const double Ridge = std::pow(1.0 - std::fabs(2.0 * Fbm(Wx * 1.5 + 3.0, Wy * 1.5 - 8.0, 5, Seed + 8U) - 1.0), 3.0);
			const double Lane = std::pow(1.0 - std::fabs(2.0 * Fbm(Wx * 0.9 - 6.0, Wy * 0.9 + 4.0, 4, Seed + 9U) - 1.0), 6.0);
			const double Outline = Fbm(Px * 0.7 + 5.0, Py * 0.7 - 3.0, 3, Seed + 6U);
			const double Hot = Fbm(Wx * 1.1 + 11.0, Wy * 1.1 - 4.0, 3, Seed + 4U);
			const double Cool = Fbm(Wx * 0.8 - 7.0, Wy * 0.8 + 13.0, 3, Seed + 5U);

			const double Body = Smoothstep(0.88, 0.12, R + (Outline - 0.5) * 1.1) * Smoothstep(1.0, 0.78, R);
			const double Gas = std::pow(Clamp01((D - 0.34) / 0.56), 2.0);
			const double Pocket = std::pow(Clamp01((D - 0.56) / 0.34), 2.0);
			double Dens = Body * (0.50 * Gas + 1.15 * Ridge * (0.25 + Gas) + 0.85 * Pocket);
			Dens *= 1.0 - 0.8 * Lane;
			// Brighter cores run toward white.
			const double White = 0.30 * Pocket * Body;
			Img.Put(X, Y, Dens * (0.72 + 0.55 * Hot) + White, Dens * (0.72 + 0.55 * Cool) + White, Dens * (0.72 + 0.55 * (1.0 - Hot)) + White);
		}
	}
	return Img;
}

enum class GalaxyKind : int
{
	Spiral = 0,
	Grand = 1,
	Barred = 2,
	EdgeOn = 3,
	Elliptical = 4,
};

/**
 * A far galaxy: a warm bulge, a disc with logarithmic spiral arms (blue, with pink star-forming knots), a faint halo,
 * a scatter of stars, and for the edge-on one a dust lane. Fades out before the border.
 */
inline Image MakeGalaxy(int Size, uint32_t Seed, GalaxyKind Kind)
{
	Image Img(Size, Size);
	const double Handed = Hash01(Seed, 3U) < 0.5 ? -1.0 : 1.0;
	const double Tilt = Hash01(Seed, 4U) * kPi;
	double Arms = 2.0;
	double Wind = 2.7;
	double Flatten = 1.0;
	double Bar = 0.0;
	double ArmPower = 2.3;
	double DiscScale = 0.30;
	double BulgeScale = 0.085;
	switch (Kind)
	{
	case GalaxyKind::Spiral: break;
	case GalaxyKind::Grand:
		Arms = 4.0;
		Wind = 3.4;
		ArmPower = 1.7;
		DiscScale = 0.34;
		break;
	case GalaxyKind::Barred:
		Wind = 2.2;
		Bar = 0.30;
		ArmPower = 2.2;
		break;
	case GalaxyKind::EdgeOn:
		Flatten = 0.22;
		DiscScale = 0.34;
		BulgeScale = 0.11;
		break;
	case GalaxyKind::Elliptical:
		Arms = 0.0;
		DiscScale = 0.0;
		BulgeScale = 0.20;
		Flatten = 0.60 + 0.2 * Hash01(Seed, 5U);
		break;
	}
	const double CosT = std::cos(Tilt);
	const double SinT = std::sin(Tilt);
	for (int Py = 0; Py < Size; ++Py)
	{
		for (int Px = 0; Px < Size; ++Px)
		{
			const double U = (static_cast<double>(Px) + 0.5) / static_cast<double>(Size) * 2.0 - 1.0;
			const double V = (static_cast<double>(Py) + 0.5) / static_cast<double>(Size) * 2.0 - 1.0;
			const double ImageR = std::sqrt(U * U + V * V);
			// Turn the picture, then look at the galaxy's own plane (a squashed one is a tilted disc).
			const double Cx = U * CosT + V * SinT;
			const double Cy = -U * SinT + V * CosT;
			const double X = Cx;
			const double Y = Cy / Flatten;
			const double R = std::sqrt(X * X + Y * Y);
			const double Theta = std::atan2(Y, X);

			// Disc and halo fade away well inside the picture, so no round edge shows.
			const double Reach = Smoothstep(0.80, 0.30, R);
			const double Bulge = std::exp(-std::pow(R / BulgeScale, 1.4)) * 1.7;
			const double Halo = 0.20 * std::exp(-R / (DiscScale * 1.4 + 0.05)) * Reach;
			double Disc = 0.0;
			double Arm = 0.0;
			double Knots = 0.0;
			double BarGlow = 0.0;
			if (DiscScale > 0.0)
			{
				const double Wobble = 2.2 * (Fbm(X * 3.2 + 5.0, Y * 3.2 - 2.0, 3, Seed) - 0.5);
				Arm = std::pow(0.5 + 0.5 * std::cos(Arms * (Theta * Handed - Wind * std::log(R + 0.04)) + Wobble), ArmPower);
				const double Clumps = 0.7 + 0.6 * Fbm(X * 8.0 + 1.0, Y * 8.0 + 3.0, 3, Seed + 9U);
				Disc = std::exp(-R / DiscScale) * (0.22 + 0.78 * Arm) * Clumps * Reach;
				Knots = std::pow(Fbm(X * 16.0 - 3.0, Y * 16.0 + 8.0, 3, Seed + 7U), 6.0) * 6.0 * Arm * std::exp(-R / DiscScale) * Reach;
			}
			if (Bar > 0.0)
			{
				BarGlow = 1.1 * std::exp(-std::pow(Y / 0.05, 2.0) - std::pow(X / Bar, 2.0));
			}
			double Lane = 1.0;
			if (Kind == GalaxyKind::EdgeOn)
			{
				Lane = 1.0 - 0.75 * std::exp(-std::pow(Cy / 0.02, 2.0));
			}

			const double Core = (Bulge + BarGlow + Halo) * Lane;
			const double DiscLight = Disc * Lane;
			double Red = Core * 1.00 + DiscLight * Lerp(0.85, 0.58, Arm) * 1.1 + Knots * 1.00;
			double Green = Core * 0.80 + DiscLight * Lerp(0.76, 0.74, Arm) * 1.1 + Knots * 0.55;
			double Blue = Core * 0.55 + DiscLight * Lerp(0.68, 1.00, Arm) * 1.1 + Knots * 0.75;
			// A scatter of single bright stars, thicker where the galaxy is.
			if (Hash01(static_cast<uint32_t>(Px), static_cast<uint32_t>(Py), Seed + 31U) > 0.9972)
			{
				const double Glint = 0.7 * (Core + DiscLight + 0.05);
				Red += Glint;
				Green += Glint;
				Blue += Glint;
			}
			const double Edge = Smoothstep(1.0, 0.78, ImageR);
			Img.Put(Px, Py, Red * Edge, Green * Edge, Blue * Edge);
		}
	}
	return Img;
}

/** One star: a hot core, a soft halo and a faint four-point glint (white: an instance's tint colours it). */
inline Image MakeStarDot(int Size)
{
	Image Img(Size, Size);
	for (int Y = 0; Y < Size; ++Y)
	{
		for (int X = 0; X < Size; ++X)
		{
			const double U = (static_cast<double>(X) + 0.5) / static_cast<double>(Size) * 2.0 - 1.0;
			const double V = (static_cast<double>(Y) + 0.5) / static_cast<double>(Size) * 2.0 - 1.0;
			const double R = std::sqrt(U * U + V * V);
			const double Core = std::exp(-std::pow(R * 6.0, 2.0));
			const double Halo = 0.22 * std::exp(-std::pow(R * 2.4, 2.0));
			const double Spike = 0.30 * (std::exp(-std::fabs(V) * 26.0 - std::fabs(U) * 3.0) + std::exp(-std::fabs(U) * 26.0 - std::fabs(V) * 3.0));
			const double I = (Core + Halo + Spike) * Smoothstep(1.0, 0.8, R);
			Img.Put(X, Y, I, I, I);
		}
	}
	return Img;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The backdrop: layers of stars, nebulae and galaxies that slide against each other (parallax)                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * How far a layer lags behind the camera. A layer that follows the camera completely (Follow 1) is a sky: it never
 * moves on screen. A layer that does not follow (Follow 0) stays where it is in the world and parallaxes the most.
 * The lag is softly capped at a third of the layer's radius, so however far the camera flies the layer stays a long
 * way off (and never lands on the camera).
 */
inline Vec3 ParallaxLag(const Vec3& Camera, double Follow, double Radius, double MaxFraction = 0.35)
{
	const Vec3 Lag = Camera * (1.0 - Follow);
	const double L = Length(Lag);
	if (L < 1e-9)
	{
		return Vec3{};
	}
	const double Cap = MaxFraction * Radius;
	return Lag * (Cap * std::tanh(L / Cap) / L);
}

/** Where a layer's centre is for a camera at Camera (the scene's centre is the origin). */
inline Vec3 LayerOrigin(const Vec3& Camera, double Follow, double Radius)
{
	return Camera - ParallaxLag(Camera, Follow, Radius);
}

enum class SpriteKind : uint8_t
{
	Star,
	Nebula,
	Galaxy,
};

struct LayerSpec
{
	const char* Name;
	SpriteKind Kind;
	/** cm from the layer's centre to its sprites. */
	double Radius;
	double Follow;
	int Count;
	/** Apparent size of a sprite, in degrees across. */
	double AngMin;
	double AngMax;
	/** How bright, as a multiple of the picture (above 1 blooms). */
	double GlowMin;
	double GlowMax;
	/** The share of sprites laid along the Milky Way band instead of anywhere. */
	double BandFraction;
	/** The whole layer turns this slowly (degrees a second), so a still camera still sees a living sky. */
	double DriftDegPerSec;
	/** The first few sprites are showpieces: big, vivid, and placed in front of the home view (the first thing you see). */
	int Showpieces;
};

/** Far to near. Parallax between neighbours is what gives the depth; most of the sky stays black. */
inline std::vector<LayerSpec> DefaultLayers()
{
	return {
		// Name            Kind                 Radius  Follow Count AngMin AngMax GlowMin GlowMax Band  Drift  Show
		{"deep-stars", SpriteKind::Star, 3.0e6, 1.00, 1500, 0.10, 0.26, 0.5, 1.7, 0.45, 0.000, 0},
		{"haze", SpriteKind::Nebula, 2.8e6, 0.97, 6, 50.0, 90.0, 0.03, 0.06, 0.0, 0.003, 0},
		{"far-galaxies", SpriteKind::Galaxy, 2.4e6, 0.92, 18, 2.6, 7.0, 0.6, 1.2, 0.0, 0.004, 1},
		{"milky-way", SpriteKind::Nebula, 2.2e6, 0.95, 14, 26.0, 44.0, 0.10, 0.20, 1.0, 0.003, 0},
		{"mid-galaxies", SpriteKind::Galaxy, 1.1e6, 0.78, 7, 5.0, 14.0, 0.8, 1.4, 0.0, 0.008, 1},
		{"mid-stars", SpriteKind::Star, 1.0e6, 0.80, 500, 0.16, 0.38, 0.9, 2.6, 0.2, 0.006, 0},
		{"mid-nebulae", SpriteKind::Nebula, 8.0e5, 0.68, 4, 18.0, 34.0, 0.20, 0.40, 0.0, 0.009, 1},
		{"nebulae", SpriteKind::Nebula, 5.0e5, 0.55, 4, 14.0, 30.0, 0.30, 0.55, 0.0, 0.012, 1},
		{"dust", SpriteKind::Star, 1.7e5, 0.25, 260, 0.20, 0.50, 1.3, 3.2, 0.0, 0.020, 0},
	};
}

struct SkyItem
{
	/** Unit direction from the layer's centre. */
	Vec3 Dir;
	/** Sprite size across, in degrees. */
	double AngDeg = 1.0;
	/** Turn about its own axis. */
	double Roll = 0.0;
	/** Which picture (nebula 0-3, galaxy 0-4; stars have one). */
	int Variant = 0;
	/** Tint (linear). */
	double R = 1.0;
	double G = 1.0;
	double B = 1.0;
	double Glow = 1.0;
};

/** The normal of the great circle the Milky Way runs along. */
inline Vec3 BandNormal() { return Normalized(Vec3{0.30, -0.35, 0.89}); }

inline Vec3 BandDirection(Rng& R, double SigmaDeg)
{
	const Vec3 N = BandNormal();
	const Vec3 E1 = Normalized(Cross(Vec3{0.0, 0.0, 1.0}, N), Vec3{1.0, 0.0, 0.0});
	const Vec3 E2 = Cross(N, E1);
	const double Lon = R.Range(0.0, 2.0 * kPi);
	const double Lat = DegToRad(R.Gauss() * SigmaDeg);
	return Normalized(E1 * (std::cos(Lat) * std::cos(Lon)) + E2 * (std::cos(Lat) * std::sin(Lon)) + N * std::sin(Lat));
}

/** The way the camera looks when it frames the whole brain (the controller's FlyHome): from behind and above, down at it. */
inline Vec3 HomeForward() { return Normalized(Vec3{1.0, 0.0, -0.45}); }

/** A direction in front of the home view, off to one side and a little up or down, so the first look has something in it. */
inline Vec3 HomeShowDirection(Rng& R)
{
	const Vec3 Fwd = HomeForward();
	const Vec3 Right = Normalized(Cross(kUp, Fwd), Vec3{0.0, 1.0, 0.0});
	const Vec3 Up = Cross(Fwd, Right);
	const double Yaw = DegToRad(R.Range(14.0, 30.0)) * (R.Chance(0.5) ? 1.0 : -1.0);
	const double Pitch = DegToRad(R.Range(-6.0, 14.0));
	return Normalized(Fwd + Right * std::tan(Yaw) + Up * std::tan(Pitch));
}

/** Moods for nebulae: the instance tint multiplies the picture's own three hues. */
inline void NebulaTint(Rng& R, double& Red, double& Green, double& Blue)
{
	static const double Palette[6][3] = {{1.00, 0.30, 0.66}, {0.25, 0.75, 1.00}, {1.00, 0.58, 0.18}, {0.55, 0.35, 1.00}, {0.30, 1.00, 0.62}, {1.00, 0.38, 0.34}};
	const int I = static_cast<int>(R.Next() * 6.0) % 6;
	Red = Palette[I][0];
	Green = Palette[I][1];
	Blue = Palette[I][2];
}

/** The sprites of one layer (Count of them: the caller may scale the spec's count by a density). */
inline std::vector<SkyItem> BuildLayerItems(const LayerSpec& L, int Count, uint32_t Seed)
{
	Rng R(Seed);
	std::vector<SkyItem> Items;
	Items.reserve(static_cast<size_t>(Count > 0 ? Count : 0));
	for (int I = 0; I < Count; ++I)
	{
		SkyItem It;
		const bool Show = I < L.Showpieces;
		It.Dir = R.Chance(L.BandFraction) ? BandDirection(R, L.Kind == SpriteKind::Nebula ? 7.0 : 9.0) : R.Unit();
		if (Show)
		{
			It.Dir = HomeShowDirection(R);
		}
		It.Roll = R.Range(0.0, 2.0 * kPi);
		switch (L.Kind)
		{
		case SpriteKind::Star:
		{
			// Mostly small, a few big; blue-white to white to warm, a rare orange.
			const double Big = R.Next();
			It.AngDeg = Lerp(L.AngMin, L.AngMax, Big * Big * Big);
			const double Heat = R.Next();
			if (Heat < 0.45)
			{
				It.R = Lerp(0.62, 0.95, Heat / 0.45);
				It.G = Lerp(0.72, 0.97, Heat / 0.45);
				It.B = 1.0;
			}
			else if (Heat < 0.92)
			{
				It.R = 1.0;
				It.G = Lerp(0.97, 0.86, (Heat - 0.45) / 0.47);
				It.B = Lerp(0.95, 0.72, (Heat - 0.45) / 0.47);
			}
			else
			{
				It.R = 1.0;
				It.G = 0.62;
				It.B = 0.38;
			}
			It.Glow = Lerp(L.GlowMin, L.GlowMax, Big);
			It.Variant = 0;
			break;
		}
		case SpriteKind::Nebula:
			It.AngDeg = Show ? R.Range(Lerp(L.AngMin, L.AngMax, 0.6), L.AngMax) : R.Range(L.AngMin, L.AngMax);
			if (L.BandFraction > 0.99)
			{
				// The Milky Way is pale: blue-white, cream, a little violet.
				static const double Pale[3][3] = {{0.74, 0.82, 1.00}, {1.00, 0.90, 0.78}, {0.82, 0.72, 1.00}};
				const int P = static_cast<int>(R.Next() * 3.0) % 3;
				It.R = Pale[P][0];
				It.G = Pale[P][1];
				It.B = Pale[P][2];
			}
			else
			{
				NebulaTint(R, It.R, It.G, It.B);
			}
			It.Glow = Show ? R.Range(Lerp(L.GlowMin, L.GlowMax, 0.6), L.GlowMax) : R.Range(L.GlowMin, L.GlowMax);
			It.Variant = static_cast<int>(R.Next() * kNebulaVariants) % kNebulaVariants;
			break;
		case SpriteKind::Galaxy:
			It.AngDeg = Show ? R.Range(Lerp(L.AngMin, L.AngMax, 0.7), L.AngMax) : R.Range(L.AngMin, L.AngMax);
			It.R = R.Range(0.88, 1.0);
			It.G = R.Range(0.88, 1.0);
			It.B = R.Range(0.9, 1.0);
			It.Glow = R.Range(L.GlowMin, L.GlowMax);
			It.Variant = static_cast<int>(R.Next() * kGalaxyVariants) % kGalaxyVariants;
			break;
		}
		Items.push_back(It);
	}
	return Items;
}

/** A sprite: a 100 cm plane facing the layer's centre (so it faces a camera near it), sized to cover AngDeg. */
inline Xf SpriteXf(const SkyItem& It, double Radius)
{
	const double W = 2.0 * Radius * std::tan(DegToRad(It.AngDeg) * 0.5);
	const Quat Face = FromZTo(-It.Dir);
	const Quat Roll = FromAxisAngle(kUp, It.Roll);
	return {It.Dir * Radius, Face * Roll, Vec3{W / 100.0, W / 100.0, 1.0}};
}

/** How the whole layer has turned after Time seconds. */
inline Quat LayerDrift(const LayerSpec& L, uint32_t Index, double Time)
{
	const Vec3 Axis = Normalized(Vec3{Hash01(Index, 1U) - 0.5, Hash01(Index, 2U) - 0.5, Hash01(Index, 3U) + 0.4});
	return FromAxisAngle(Axis, DegToRad(L.DriftDegPerSec) * Time);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Things that fly through: a stateless path from one side of the scene to the other, again and again               */
/* ------------------------------------------------------------------------------------------------------------------ */

struct FlybyParams
{
	/** The path starts and ends on a sphere this many Fields around the centre. */
	double Shell = 4.0;
	double SpeedMin = 2000.0;
	double SpeedMax = 7000.0;
	/** Quiet seconds between passes, up to this. */
	double IdleMax = 5.0;
	/** The closest the path comes to the centre is between MissMin and MissMax Fields (exactly: a mother ship never cuts through the brain). */
	double MissMin = 0.0;
	double MissMax = 1.0;
};

struct FlybyState
{
	bool Visible = false;
	Vec3 Pos;
	Vec3 Dir{1.0, 0.0, 0.0};
	double Speed = 0.0;
	/** 0 at both ends of the path, 1 in the middle: scale by it so nothing pops in or out. */
	double Fade = 0.0;
	/** How near this pass comes to the centre, at its closest. */
	double Miss = 0.0;
	uint32_t Cycle = 0;
};

/** Where flyby `Id` is at `Time`. A function of its arguments only. */
inline FlybyState EvalFlyby(uint32_t Id, double Time, const Vec3& Center, double Field, const FlybyParams& P)
{
	FlybyState S;
	const double Shell = P.Shell * Field;
	S.Speed = Lerp(P.SpeedMin, P.SpeedMax, Hash01(Id, 11U));
	const double Idle = P.IdleMax * Hash01(Id, 12U);
	// A pass is never longer than the sphere's diameter, so this period always holds one.
	const double Period = 2.0 * Shell / S.Speed + Idle;
	const double Local = Time + Hash01(Id, 13U) * Period;
	const double CycleF = std::floor(Local / Period);
	S.Cycle = static_cast<uint32_t>(static_cast<int64_t>(CycleF) & 0x7fffffff);
	const double Since = Local - CycleF * Period;

	// The pass: a straight line along Dir whose closest point to the centre is Miss away, sideways; it enters and
	// leaves the shell Half before and after that point.
	Rng R(HashU(Id, S.Cycle, 17U));
	S.Miss = Clamp(Field * Lerp(P.MissMin, P.MissMax, R.Next()), 0.0, 0.9 * Shell);
	S.Dir = R.Unit();
	Vec3 Side = Cross(S.Dir, R.Unit());
	if (Length(Side) < 1e-6)
	{
		Side = Cross(S.Dir, Vec3{1.0, 0.0, 0.0});
		if (Length(Side) < 1e-6)
		{
			Side = Cross(S.Dir, Vec3{0.0, 1.0, 0.0});
		}
	}
	const Vec3 Closest = Center + Normalized(Side) * S.Miss;
	const double Half = std::sqrt(Shell * Shell - S.Miss * S.Miss);
	const double Chord = 2.0 * Half;
	const double Along = Since * S.Speed;
	S.Pos = Closest - S.Dir * Half + S.Dir * Along;
	const double Ramp = 0.08 * Chord;
	S.Fade = Smoothstep(0.0, Ramp, Along) * Smoothstep(Chord, Chord - Ramp, Along);
	S.Visible = Along <= Chord && S.Fade > 0.002;
	return S;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Asteroids                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

enum class Prim : uint8_t
{
	Sphere,
	Cylinder,
	Cone,
	Cube,
};

/** One lump of a rock: an ellipsoid or a chunk, offset and turned (cm, relative to the rock's centre and its own frame). */
struct Lump
{
	Vec3 Offset;
	Vec3 Size{100.0, 100.0, 100.0};
	Quat Rot;
	/** A rounded lump (Sphere) or an angular chunk (Cube). */
	Prim Shape = Prim::Sphere;
	/** Multiplies the rock's colour, so lumps differ a little. */
	double Shade = 1.0;
};

struct RockLook
{
	double SizeCm = 100.0;
	Lump Lumps[3];
	/** Albedo (linear) and how metallic. */
	double R = 0.25;
	double G = 0.22;
	double B = 0.20;
	double Metal = 0.0;
};

/** A rubble pile: a rounded body with an angular chunk (or two) stuck in it, in one of a few kinds of rock. */
inline RockLook MakeRockLook(Rng& R, double SizeCm)
{
	RockLook Look;
	Look.SizeCm = SizeCm;
	Look.Lumps[0] = {Vec3{}, Vec3{SizeCm * R.Range(0.85, 1.2), SizeCm * R.Range(0.7, 1.05), SizeCm * R.Range(0.6, 0.95)}, FromAxisAngle(R.Unit(), R.Range(0.0, 2.0 * kPi)), Prim::Sphere, R.Range(0.9, 1.1)};
	for (int I = 1; I < 3; ++I)
	{
		const bool Chunk = I == 1 ? R.Chance(0.75) : R.Chance(0.4);
		const double Side = SizeCm * (Chunk ? R.Range(0.42, 0.62) : R.Range(0.5, 0.78));
		Look.Lumps[I] = {R.Unit() * (SizeCm * R.Range(0.28, 0.46)), Vec3{Side * R.Range(0.8, 1.2), Side * R.Range(0.7, 1.1), Side * R.Range(0.7, 1.1)},
			FromAxisAngle(R.Unit(), R.Range(0.0, 2.0 * kPi)), Chunk ? Prim::Cube : Prim::Sphere, R.Range(0.82, 1.18)};
	}
	const double Kind = R.Next();
	if (Kind < 0.60)
	{
		const double Grey = R.Range(0.09, 0.22);
		Look.R = Grey * R.Range(1.0, 1.18);
		Look.G = Grey;
		Look.B = Grey * R.Range(0.82, 1.0);
		Look.Metal = R.Range(0.0, 0.2);
	}
	else if (Kind < 0.80)
	{
		const double Grey = R.Range(0.05, 0.10);
		Look.R = Grey;
		Look.G = Grey;
		Look.B = Grey * 1.06;
		Look.Metal = R.Range(0.0, 0.15);
	}
	else if (Kind < 0.92)
	{
		const double Scale = R.Range(0.55, 0.95);
		Look.R = 0.30 * Scale;
		Look.G = 0.15 * Scale;
		Look.B = 0.08 * Scale;
		Look.Metal = R.Range(0.0, 0.2);
	}
	else if (Kind < 0.97)
	{
		Look.R = 0.42;
		Look.G = 0.50;
		Look.B = 0.58;
		Look.Metal = 0.0;
	}
	else
	{
		const double Grey = R.Range(0.24, 0.36);
		Look.R = Grey;
		Look.G = Grey * 0.95;
		Look.B = Grey * 0.9;
		Look.Metal = R.Range(0.55, 0.8);
	}
	return Look;
}

/** The size of a rock: many small, a few big, now and then a boulder. */
inline double RockSizeCm(Rng& R)
{
	if (R.Chance(0.008))
	{
		return R.Range(600.0, 950.0);
	}
	const double U = R.Next();
	return Lerp(30.0, 420.0, U * U * U);
}

struct OrbitFrame
{
	Vec3 E1{1.0, 0.0, 0.0};
	Vec3 E2{0.0, 1.0, 0.0};
	Vec3 E3{0.0, 0.0, 1.0};
};

/** A plane tilted up to MaxInclDeg from level, about a random horizontal axis, turned a random way round. */
inline OrbitFrame RandomOrbitFrame(Rng& R, double MaxInclDeg)
{
	const double Phi = R.Range(0.0, 2.0 * kPi);
	const Quat Tilt = FromAxisAngle(Vec3{std::cos(Phi), std::sin(Phi), 0.0}, DegToRad(MaxInclDeg) * R.Next());
	const Quat Turn = FromAxisAngle(kUp, R.Range(0.0, 2.0 * kPi));
	const Quat Q = Tilt * Turn;
	return {Rotate(Q, Vec3{1.0, 0.0, 0.0}), Rotate(Q, Vec3{0.0, 1.0, 0.0}), Rotate(Q, Vec3{0.0, 0.0, 1.0})};
}

/** A rock going round the brain. */
struct BeltRock
{
	OrbitFrame Frame;
	/** Distance and height, in Fields. */
	double Radius01 = 1.0;
	double Height01 = 0.0;
	double Angle0 = 0.0;
	/** Radians a second (negative: the other way round). */
	double Omega = 0.1;
	Vec3 SpinAxis{0.0, 0.0, 1.0};
	double SpinRate = 0.5;
	double Spin0 = 0.0;
	RockLook Look;
};

struct Pose
{
	Vec3 Pos;
	Quat Rot;
};

/**
 * Rocks in three belts (level, tilted, nearly polar) plus a loose crowd on orbits of their own; most amble, some
 * race. Speeds are cm a second at the nominal field.
 */
inline std::vector<BeltRock> BuildBelt(int Count, uint32_t Seed)
{
	Rng R(Seed);
	const OrbitFrame Belts[3] = {RandomOrbitFrame(R, 12.0), RandomOrbitFrame(R, 38.0), RandomOrbitFrame(R, 90.0)};
	const double BeltRadius[3] = {1.05, 1.55, 2.25};
	std::vector<BeltRock> Rocks;
	Rocks.reserve(static_cast<size_t>(Count > 0 ? Count : 0));
	for (int I = 0; I < Count; ++I)
	{
		BeltRock B;
		if (R.Chance(0.70))
		{
			const int Which = static_cast<int>(R.Next() * 3.0) % 3;
			B.Frame = Belts[Which];
			B.Radius01 = Clamp(BeltRadius[Which] + R.Gauss() * 0.16, 0.9, 3.0);
			B.Height01 = R.Gauss() * 0.07;
		}
		else
		{
			B.Frame = RandomOrbitFrame(R, 90.0);
			B.Radius01 = R.Range(0.95, 2.7);
			B.Height01 = R.Gauss() * 0.05;
		}
		B.Angle0 = R.Range(0.0, 2.0 * kPi);
		const double U = R.Next();
		const double Speed = R.Chance(0.06) ? R.Range(4500.0, 8000.0) : Lerp(250.0, 2200.0, U * U);
		B.Omega = (R.Chance(0.25) ? -1.0 : 1.0) * Speed / (B.Radius01 * kNominalField);
		B.SpinAxis = R.Unit();
		B.SpinRate = R.Range(-1.4, 1.4);
		B.Spin0 = R.Range(0.0, 2.0 * kPi);
		B.Look = MakeRockLook(R, RockSizeCm(R));
		Rocks.push_back(B);
	}
	return Rocks;
}

inline Pose EvalBelt(const BeltRock& B, double Time, const Vec3& Center, double Field)
{
	const double A = B.Angle0 + B.Omega * Time;
	const double R = B.Radius01 * Field;
	const Vec3 Pos = Center + B.Frame.E1 * (R * std::cos(A)) + B.Frame.E2 * (R * std::sin(A)) + B.Frame.E3 * (B.Height01 * Field);
	return {Pos, FromAxisAngle(B.SpinAxis, B.Spin0 + B.SpinRate * Time)};
}

/** A rock zooming through: its look and spin (its path is EvalFlyby). */
struct FlybyRock
{
	uint32_t Id = 0;
	Vec3 SpinAxis{0.0, 0.0, 1.0};
	double SpinRate = 1.0;
	RockLook Look;
};

inline FlybyParams RockFlyby()
{
	FlybyParams P;
	P.Shell = 3.6;
	P.SpeedMin = 3000.0;
	P.SpeedMax = 9500.0;
	P.IdleMax = 8.0;
	P.MissMin = 0.15;
	P.MissMax = 1.35;
	return P;
}

inline std::vector<FlybyRock> BuildFlybyRocks(int Count, uint32_t Seed)
{
	Rng R(Seed);
	std::vector<FlybyRock> Rocks;
	for (int I = 0; I < Count; ++I)
	{
		FlybyRock F;
		F.Id = HashU(Seed, static_cast<uint32_t>(I), 201U);
		F.SpinAxis = R.Unit();
		F.SpinRate = R.Range(-2.6, 2.6);
		// Bigger than the belt's: they are seen going past.
		F.Look = MakeRockLook(R, Lerp(60.0, 520.0, R.Next() * R.Next()));
		Rocks.push_back(F);
	}
	return Rocks;
}

inline Pose EvalFlybyRock(const FlybyRock& F, double Time, const Vec3& Center, double Field, double& Fade)
{
	const FlybyState S = EvalFlyby(F.Id, Time, Center, Field, RockFlyby());
	Fade = S.Visible ? S.Fade : 0.0;
	return {S.Pos, FromAxisAngle(F.SpinAxis, F.SpinRate * Time)};
}

/** The world transform of lump `Index` of a rock (Fade scales the rock about its centre). */
inline Xf LumpWorld(const RockLook& Look, int Index, const Pose& P, double Fade, double SizeScale)
{
	const Lump& L = Look.Lumps[Index];
	const double F = Fade * SizeScale;
	return {P.Pos + Rotate(P.Rot, L.Offset * F), P.Rot * L.Rot, L.Size * (F / 100.0)};
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Shooting stars                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

struct Streak
{
	uint32_t Id = 0;
	/** Length and thickness at full size (cm). */
	double LengthCm = 1500.0;
	double ThickCm = 18.0;
	double R = 0.8;
	double G = 0.9;
	double B = 1.0;
	double Glow = 3.0;
};

inline FlybyParams StreakFlyby()
{
	FlybyParams P;
	P.Shell = 3.2;
	P.SpeedMin = 14000.0;
	P.SpeedMax = 26000.0;
	P.IdleMax = 14.0;
	P.MissMin = 0.2;
	P.MissMax = 1.7;
	return P;
}

inline std::vector<Streak> BuildStreaks(int Count, uint32_t Seed)
{
	Rng R(Seed);
	std::vector<Streak> Streaks;
	for (int I = 0; I < Count; ++I)
	{
		Streak S;
		S.Id = HashU(Seed, static_cast<uint32_t>(I), 301U);
		S.LengthCm = R.Range(700.0, 2600.0);
		S.ThickCm = R.Range(10.0, 26.0);
		const double Hue = R.Next();
		if (Hue < 0.6)
		{
			S.R = 0.75;
			S.G = 0.88;
			S.B = 1.0;
		}
		else if (Hue < 0.85)
		{
			S.R = 1.0;
			S.G = 0.82;
			S.B = 0.55;
		}
		else
		{
			S.R = 0.7;
			S.G = 1.0;
			S.B = 0.8;
		}
		S.Glow = R.Range(2.4, 5.0);
		Streaks.push_back(S);
	}
	return Streaks;
}

/** A streak is a thin cylinder along its path whose head leads (Pos is its middle). */
inline Xf StreakXf(const Streak& S, double Time, const Vec3& Center, double Field, bool& Visible)
{
	const FlybyState F = EvalFlyby(S.Id, Time, Center, Field, StreakFlyby());
	Visible = F.Visible;
	const double Len = S.LengthCm * F.Fade;
	return {F.Pos - F.Dir * (Len * 0.5), FromZTo(F.Dir), Vec3{S.ThickCm / 100.0 * F.Fade, S.ThickCm / 100.0 * F.Fade, Len / 100.0}};
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Alien ships: built from the engine's basic shapes, flown along stateless paths                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

enum class ShipDesign : uint8_t
{
	Saucer,
	Dart,
	Mother,
	Orb,
};

enum class ShipPath : uint8_t
{
	/** Round the brain on a tilted ring. */
	Patrol,
	/** A squadron zooming through in formation. */
	Squadron,
	/** A huge slow one sailing past. */
	Drift,
	/** A scout darting about the brain. */
	Zip,
};

/** Which colour a lit part wears. */
enum class Tone : uint8_t
{
	/** The ship's own hull colour. */
	Hull,
	/** A lighter plate. */
	Plate,
	/** The ship's faction colour, glowing. */
	Faction,
	/** Cockpit and window light (cool white). */
	Window,
	/** Engines (hot orange-white). */
	Engine,
};

/**
 * One part of a ship, in ship units (a ship's UnitCm says how many cm that is): Pos in the ship's frame (X forward,
 * Y right, Z up); Size is its full extent on each axis (cylinders and cones: width, width, length along Dir);
 * Dir points a cylinder's or a cone's length (a cone's tip); Yaw turns it about the ship's up afterwards.
 */
struct Part
{
	Prim Shape;
	Tone Colour;
	Vec3 Pos;
	Vec3 Size;
	Vec3 Dir;
	double YawDeg;
};

inline bool IsGlowTone(Tone T) { return T == Tone::Faction || T == Tone::Window || T == Tone::Engine; }

inline std::vector<Part> ShipParts(ShipDesign Design)
{
	const Vec3 Z{0.0, 0.0, 1.0};
	const Vec3 X{1.0, 0.0, 0.0};
	const Vec3 NegX{-1.0, 0.0, 0.0};
	const Vec3 Y{0.0, 1.0, 0.0};
	std::vector<Part> P;
	switch (Design)
	{
	case ShipDesign::Saucer:
		P.push_back({Prim::Sphere, Tone::Hull, {0.0, 0.0, 0.0}, {10.0, 10.0, 2.4}, Z, 0.0});
		P.push_back({Prim::Cylinder, Tone::Plate, {0.0, 0.0, -0.05}, {9.3, 9.3, 0.45}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Window, {0.0, 0.0, 0.95}, {4.4, 4.4, 3.0}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Faction, {0.0, 0.0, -1.1}, {5.2, 5.2, 1.1}, Z, 0.0});
		for (int I = 0; I < 12; ++I)
		{
			const double A = 2.0 * kPi * static_cast<double>(I) / 12.0;
			P.push_back({Prim::Sphere, Tone::Faction, {4.75 * std::cos(A), 4.75 * std::sin(A), 0.0}, {0.62, 0.62, 0.62}, Z, 0.0});
		}
		break;
	case ShipDesign::Dart:
		P.push_back({Prim::Cylinder, Tone::Hull, {0.0, 0.0, 0.0}, {1.0, 1.0, 7.0}, X, 0.0});
		P.push_back({Prim::Cone, Tone::Plate, {4.8, 0.0, 0.0}, {1.0, 1.0, 2.6}, X, 0.0});
		P.push_back({Prim::Cube, Tone::Hull, {-1.2, 2.9, 0.0}, {2.8, 5.6, 0.2}, Z, 25.0});
		P.push_back({Prim::Cube, Tone::Hull, {-1.2, -2.9, 0.0}, {2.8, 5.6, 0.2}, Z, -25.0});
		P.push_back({Prim::Cube, Tone::Plate, {-3.0, 0.0, 0.95}, {1.9, 0.16, 1.9}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Window, {1.7, 0.0, 0.5}, {1.5, 0.8, 0.7}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Engine, {-3.7, 0.5, 0.0}, {0.9, 0.9, 0.9}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Engine, {-3.7, -0.5, 0.0}, {0.9, 0.9, 0.9}, Z, 0.0});
		P.push_back({Prim::Cylinder, Tone::Engine, {-6.4, 0.5, 0.0}, {0.42, 0.42, 5.0}, X, 0.0});
		P.push_back({Prim::Cylinder, Tone::Engine, {-6.4, -0.5, 0.0}, {0.42, 0.42, 5.0}, X, 0.0});
		P.push_back({Prim::Sphere, Tone::Faction, {-1.6, 5.5, 0.0}, {0.5, 0.5, 0.5}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Faction, {-1.6, -5.5, 0.0}, {0.5, 0.5, 0.5}, Z, 0.0});
		break;
	case ShipDesign::Mother:
		P.push_back({Prim::Sphere, Tone::Hull, {0.0, 0.0, 0.0}, {30.0, 10.0, 8.0}, Z, 0.0});
		P.push_back({Prim::Cylinder, Tone::Plate, {1.0, 0.0, 4.2}, {2.6, 2.6, 34.0}, X, 0.0});
		P.push_back({Prim::Cone, Tone::Hull, {20.5, 3.6, 1.6}, {3.0, 3.0, 13.0}, X, 0.0});
		P.push_back({Prim::Cone, Tone::Hull, {20.5, -3.6, 1.6}, {3.0, 3.0, 13.0}, X, 0.0});
		P.push_back({Prim::Cone, Tone::Hull, {20.5, 3.6, -1.6}, {3.0, 3.0, 13.0}, X, 0.0});
		P.push_back({Prim::Cone, Tone::Hull, {20.5, -3.6, -1.6}, {3.0, 3.0, 13.0}, X, 0.0});
		P.push_back({Prim::Sphere, Tone::Engine, {-15.0, 0.0, 0.0}, {5.2, 5.2, 5.2}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Engine, {-14.0, 3.6, 0.8}, {3.6, 3.6, 3.6}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Engine, {-14.0, -3.6, 0.8}, {3.6, 3.6, 3.6}, Z, 0.0});
		for (int I = 0; I < 12; ++I)
		{
			const double Along = -11.0 + 2.0 * static_cast<double>(I);
			// Glowing ribs across the top (each a thin cylinder laid sideways).
			P.push_back({Prim::Cylinder, Tone::Faction, {Along, 0.0, 3.0 + 1.2 * (1.0 - std::fabs(Along) / 14.0)}, {0.45, 0.45, 7.5 - 0.15 * std::fabs(Along)}, Y, 0.0});
		}
		for (int I = 0; I < 20; ++I)
		{
			const double Along = -12.0 + 1.25 * static_cast<double>(I);
			const double Side = (I % 2 == 0) ? 1.0 : -1.0;
			const double Reach = 4.1 * std::sqrt(Clamp01(1.0 - (Along / 15.0) * (Along / 15.0)));
			P.push_back({Prim::Sphere, Tone::Window, {Along, Side * Reach, 0.4 + 0.5 * Hash01(static_cast<uint32_t>(I), 9U)}, {0.5, 0.5, 0.5}, Z, 0.0});
		}
		break;
	case ShipDesign::Orb:
		P.push_back({Prim::Sphere, Tone::Hull, {0.0, 0.0, 0.0}, {3.0, 3.0, 3.0}, Z, 0.0});
		P.push_back({Prim::Cylinder, Tone::Faction, {0.0, 0.0, 0.0}, {3.25, 3.25, 0.22}, Z, 0.0});
		P.push_back({Prim::Cone, Tone::Plate, {0.0, 0.0, 1.9}, {0.55, 0.55, 1.5}, Z, 0.0});
		P.push_back({Prim::Cone, Tone::Plate, {0.0, 0.0, -1.9}, {0.55, 0.55, 1.5}, {0.0, 0.0, -1.0}, 0.0});
		P.push_back({Prim::Sphere, Tone::Window, {1.55, 0.0, 0.0}, {0.7, 0.7, 0.7}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Faction, {0.0, 1.45, 0.45}, {0.4, 0.4, 0.4}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Faction, {0.0, -1.45, 0.45}, {0.4, 0.4, 0.4}, Z, 0.0});
		P.push_back({Prim::Sphere, Tone::Engine, {-1.55, 0.0, 0.0}, {0.8, 0.8, 0.8}, Z, 0.0});
		break;
	}
	(void)NegX;
	return P;
}

struct ShipSpec
{
	ShipDesign Design = ShipDesign::Saucer;
	ShipPath Path = ShipPath::Patrol;
	/** Its own random streams. */
	uint32_t Id = 0;
	/** A squadron's members share the group's path; Member 0 leads. */
	uint32_t Group = 0;
	int Member = 0;
	/** cm per ship unit. */
	double UnitCm = 50.0;
	/** How fast it flies (cm a second) and, for a saucer, how fast it turns (rad a second). */
	double Speed = 1000.0;
	double SpinRate = 0.0;
	/** Faction colour (glowing) and hull colour, linear. */
	double GlowR = 0.2;
	double GlowG = 0.9;
	double GlowB = 1.0;
	double HullR = 0.2;
	double HullG = 0.2;
	double HullB = 0.22;
	double Metal = 0.3;
};

struct ShipPose
{
	Vec3 Pos;
	Quat Rot;
	/** Scale of the whole ship: 0 while it is off on its pass, 1 in view. */
	double Fade = 1.0;
};

inline FlybyParams SquadronFlyby(double Speed)
{
	FlybyParams P;
	P.Shell = 4.0;
	P.SpeedMin = Speed;
	P.SpeedMax = Speed;
	P.IdleMax = 10.0;
	// Squadrons zoom past the brain, not through it.
	P.MissMin = 0.95;
	P.MissMax = 1.8;
	return P;
}

inline FlybyParams DriftFlyby(double Speed)
{
	FlybyParams P;
	P.Shell = 7.5;
	P.SpeedMin = Speed;
	P.SpeedMax = Speed;
	P.IdleMax = 0.0;
	P.MissMin = 1.6;
	P.MissMax = 2.6;
	return P;
}

/** Where, how turned and how big a ship is at Time. */
inline ShipPose EvalShip(const ShipSpec& S, double Time, const Vec3& Center, double Field)
{
	ShipPose Out;
	switch (S.Path)
	{
	case ShipPath::Patrol:
	{
		Rng R(HashU(S.Id, 1U));
		const OrbitFrame F = RandomOrbitFrame(R, 40.0);
		const double Radius01 = R.Range(1.5, 2.8);
		const double A0 = R.Range(0.0, 2.0 * kPi);
		const double Phase = R.Range(0.0, 2.0 * kPi);
		const double Omega = S.Speed / (Radius01 * kNominalField);
		const auto At = [&](double T)
		{
			const double A = A0 + Omega * T;
			const double Rad = Radius01 * Field;
			return Center + F.E1 * (Rad * std::cos(A)) + F.E2 * (Rad * 0.85 * std::sin(A)) + F.E3 * (0.10 * Rad * std::sin(2.3 * A + Phase));
		};
		Out.Pos = At(Time);
		const Vec3 Vel = At(Time + 0.05) - At(Time - 0.05);
		Out.Rot = LookRotation(Vel, F.E3) * FromAxisAngle(kUp, S.SpinRate * Time);
		break;
	}
	case ShipPath::Squadron:
	{
		const FlybyState L = EvalFlyby(S.Group, Time, Center, Field, SquadronFlyby(S.Speed));
		static const double Formation[5][3] = {{0.0, 0.0, 0.0}, {-1.3, 1.1, 0.0}, {-1.3, -1.1, 0.0}, {-2.6, 2.2, 0.2}, {-2.6, -2.2, 0.2}};
		const int M = S.Member < 0 ? 0 : (S.Member > 4 ? 4 : S.Member);
		const Quat Frame = LookRotation(L.Dir, kUp);
		const Vec3 Offset{Formation[M][0], Formation[M][1], Formation[M][2]};
		Out.Pos = L.Pos + Rotate(Frame, Offset * (S.UnitCm * 10.0));
		const double Bank = 0.35 * std::sin(0.8 * Time + 1.7 * static_cast<double>(S.Member));
		Out.Rot = Frame * FromAxisAngle(Vec3{1.0, 0.0, 0.0}, Bank);
		Out.Fade = L.Visible ? L.Fade : 0.0;
		break;
	}
	case ShipPath::Drift:
	{
		const FlybyState L = EvalFlyby(S.Id, Time, Center, Field, DriftFlyby(S.Speed));
		Out.Pos = L.Pos;
		Out.Rot = LookRotation(L.Dir, kUp);
		Out.Fade = L.Visible ? L.Fade : 0.0;
		break;
	}
	case ShipPath::Zip:
	{
		Rng R(HashU(S.Id, 2U));
		const OrbitFrame F = RandomOrbitFrame(R, 70.0);
		const double A0 = R.Range(0.0, 2.0 * kPi);
		const double W1 = R.Range(0.25, 0.55) * (R.Chance(0.5) ? -1.0 : 1.0);
		const double W2 = R.Range(0.3, 0.9);
		const double W3 = R.Range(0.18, 0.5);
		const double W4 = R.Range(0.2, 0.6);
		const double P3 = R.Range(0.0, 2.0 * kPi);
		const double P4 = R.Range(0.0, 2.0 * kPi);
		const auto At = [&](double T)
		{
			// Always outside 0.9 Field: swings in and out, speeds up and slows down, bobs above and below.
			const double A = A0 + W1 * T + 0.6 * std::sin(W2 * T);
			const double Rad = Field * (1.35 + 0.45 * std::sin(W3 * T + P3));
			const double H = Field * 0.35 * std::sin(W4 * T + P4);
			return Center + F.E1 * (Rad * std::cos(A)) + F.E2 * (Rad * std::sin(A)) + F.E3 * H;
		};
		Out.Pos = At(Time);
		Out.Rot = LookRotation(At(Time + 0.05) - At(Time - 0.05), kUp);
		break;
	}
	}
	return Out;
}

/** The transform of one part of a ship. */
inline Xf PartWorld(const Part& P, const ShipPose& S, double UnitCm)
{
	const double F = UnitCm * S.Fade;
	const Quat Local = FromAxisAngle(kUp, DegToRad(P.YawDeg)) * FromZTo(P.Dir);
	return {S.Pos + Rotate(S.Rot, P.Pos * F), S.Rot * Local, P.Size * (F / 100.0)};
}

/** The fleet: saucers on patrol, two squadrons of darts, two mother ships, scouts. Density scales the counts. */
inline std::vector<ShipSpec> DefaultFleet(uint32_t Seed, double Density)
{
	Rng R(Seed);
	// Faction colours (glowing): cyan, magenta, lime, amber, violet.
	static const double Factions[5][3] = {{0.20, 0.90, 1.00}, {1.00, 0.20, 0.80}, {0.50, 1.00, 0.30}, {1.00, 0.60, 0.15}, {0.60, 0.40, 1.00}};
	const auto Paint = [&](ShipSpec& S, int Faction)
	{
		const int F = Faction % 5;
		S.GlowR = Factions[F][0];
		S.GlowG = Factions[F][1];
		S.GlowB = Factions[F][2];
		const double Grey = R.Range(0.07, 0.16);
		S.HullR = Grey * (0.9 + 0.3 * Factions[F][0]);
		S.HullG = Grey * (0.9 + 0.3 * Factions[F][1]);
		S.HullB = Grey * (0.95 + 0.3 * Factions[F][2]);
		S.Metal = R.Range(0.2, 0.5);
	};
	const auto Count = [&](int N) { return static_cast<int>(std::floor(static_cast<double>(N) * Density + 0.5)); };

	std::vector<ShipSpec> Fleet;
	uint32_t Next = 1U;
	for (int I = 0; I < Count(5); ++I)
	{
		ShipSpec S;
		S.Design = ShipDesign::Saucer;
		S.Path = ShipPath::Patrol;
		S.Id = HashU(Seed, Next++, 401U);
		S.UnitCm = R.Range(38.0, 60.0);
		S.Speed = R.Range(700.0, 1500.0);
		S.SpinRate = R.Range(0.5, 1.1);
		Paint(S, I);
		Fleet.push_back(S);
	}
	for (int G = 0; G < Count(2); ++G)
	{
		const uint32_t Group = HashU(Seed, Next++, 501U);
		const double Speed = R.Range(3800.0, 6500.0);
		const int Faction = G + 1;
		for (int M = 0; M < 4; ++M)
		{
			ShipSpec S;
			S.Design = ShipDesign::Dart;
			S.Path = ShipPath::Squadron;
			S.Id = HashU(Group, static_cast<uint32_t>(M), 502U);
			S.Group = Group;
			S.Member = M;
			S.UnitCm = 30.0;
			S.Speed = Speed;
			Paint(S, Faction);
			S.GlowR = Factions[Faction % 5][0];
			S.GlowG = Factions[Faction % 5][1];
			S.GlowB = Factions[Faction % 5][2];
			Fleet.push_back(S);
		}
	}
	for (int I = 0; I < Count(2); ++I)
	{
		ShipSpec S;
		S.Design = ShipDesign::Mother;
		S.Path = ShipPath::Drift;
		S.Id = HashU(Seed, Next++, 601U);
		S.UnitCm = R.Range(170.0, 250.0);
		S.Speed = R.Range(220.0, 420.0);
		Paint(S, I + 2);
		Fleet.push_back(S);
	}
	for (int I = 0; I < Count(6); ++I)
	{
		ShipSpec S;
		S.Design = ShipDesign::Orb;
		S.Path = ShipPath::Zip;
		S.Id = HashU(Seed, Next++, 701U);
		S.UnitCm = R.Range(75.0, 110.0);
		Paint(S, I + 3);
		Fleet.push_back(S);
	}
	return Fleet;
}

/** The linear colour (and metal) a part wears on this ship; a glowing part's Glow says how bright. */
struct PartLook
{
	double R;
	double G;
	double B;
	/** Hull parts: how metallic. Glowing parts: how bright (a multiple above 1 blooms). */
	double Extra;
};

inline PartLook LookOf(const ShipSpec& S, Tone T)
{
	switch (T)
	{
	case Tone::Hull: return {S.HullR, S.HullG, S.HullB, S.Metal};
	case Tone::Plate: return {Clamp01(S.HullR * 1.7 + 0.04), Clamp01(S.HullG * 1.7 + 0.04), Clamp01(S.HullB * 1.7 + 0.05), Clamp01(S.Metal + 0.15)};
	case Tone::Faction: return {S.GlowR, S.GlowG, S.GlowB, 3.4};
	case Tone::Window: return {0.80, 0.95, 1.00, 2.4};
	case Tone::Engine: return {1.00, 0.62, 0.28, 4.2};
	}
	return {1.0, 1.0, 1.0, 1.0};
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The two lights of the stage (the actor makes them; the preview picture uses the same numbers)                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * A warm key light and a cool, weak fill from the other side, as Unreal rotations (degrees). Intensities are lux. The
 * stage's exposure is fixed at EV 0 (see AetherBrainGameMode), where 1 lux on a white surface is about 0.27 on screen.
 */
struct StageLight
{
	double Pitch;
	double Yaw;
	double Lux;
	double R;
	double G;
	double B;
};

constexpr StageLight kKeyLight{-32.0, 38.0, 2.6, 1.00, 0.93, 0.82};
constexpr StageLight kFillLight{-14.0, 218.0, 0.5, 0.55, 0.66, 1.00};

/** The direction a light shines in (Unreal's pitch and yaw: X forward, positive pitch looks up). */
inline Vec3 LightForward(const StageLight& L)
{
	const double P = DegToRad(L.Pitch);
	const double Y = DegToRad(L.Yaw);
	return {std::cos(P) * std::cos(Y), std::cos(P) * std::sin(Y), std::sin(P)};
}

/** How far out everything is laid out around the brain: its radius plus a margin, never below the nominal. */
inline double FieldRadius(double BrainRadius, double MinField = kNominalField) { return BrainRadius * 1.15 > MinField ? BrainRadius * 1.15 : MinField; }

} // namespace AetherSpace
