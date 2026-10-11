// Photographic skies and suns, made of noise: an 8K equirectangular sky (gas and dust lit in three emission colours, a
// galactic band, tens of thousands of stars of every temperature), an 8K sun map (convection cells, sunspots, faculae,
// any stellar temperature) and a corona sprite. Plain C++ with no Unreal types, so the same code makes the pictures in
// the viewer (a background thread, then cached) and in the host preview, and tests/space_core_test.cpp can check it.
//
// Every picture is a function of its seed: the same number, the same sky. Pixels come out as Unreal's PF_B8G8R8A8 wants
// them (AetherSpace::Image), sRGB, dithered so that a dark gradient does not band at 8 bits.
#pragma once

#include "AetherSpaceMath.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <thread>
#include <vector>

namespace AetherSky
{
using AetherSpace::Clamp;
using AetherSpace::Clamp01;
using AetherSpace::Hash01;
using AetherSpace::HashU;
using AetherSpace::Image;
using AetherSpace::kPi;
using AetherSpace::Lerp;
using AetherSpace::Smoothstep;
using AetherSpace::Vec3;

constexpr double kTwoPi = 2.0 * kPi;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Running a picture's rows on every core                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Calls Row(y) for every y in [0, Height), spread over `Threads` threads (0 = what the machine has, at most 16). */
template <typename RowFn>
inline void ParallelRows(int Height, RowFn Row, unsigned Threads = 0U)
{
	unsigned N = Threads != 0U ? Threads : std::thread::hardware_concurrency();
	N = std::max(1U, std::min(N, 16U));
	if (N == 1U || Height < 8)
	{
		for (int Y = 0; Y < Height; ++Y)
		{
			Row(Y);
		}
		return;
	}
	std::vector<std::thread> Pool;
	Pool.reserve(N);
	for (unsigned T = 0; T < N; ++T)
	{
		Pool.emplace_back([&Row, Height, T, N]() {
			// Interleaved rows: the work per row differs, and neighbouring rows are alike.
			for (int Y = static_cast<int>(T); Y < Height; Y += static_cast<int>(N))
			{
				Row(Y);
			}
		});
	}
	for (std::thread& Th : Pool)
	{
		Th.join();
	}
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 3D noise: gradient noise, fractal sums, ridged noise, cells                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

inline double Fade5(double T) { return T * T * T * (T * (T * 6.0 - 15.0) + 10.0); }

inline double Grad3(uint32_t H, double X, double Y, double Z)
{
	switch (H % 12U)
	{
	case 0U: return X + Y;
	case 1U: return -X + Y;
	case 2U: return X - Y;
	case 3U: return -X - Y;
	case 4U: return X + Z;
	case 5U: return -X + Z;
	case 6U: return X - Z;
	case 7U: return -X - Z;
	case 8U: return Y + Z;
	case 9U: return -Y + Z;
	case 10U: return Y - Z;
	default: return -Y - Z;
	}
}

inline uint32_t Lat3(int X, int Y, int Z, uint32_t Seed)
{
	return HashU(static_cast<uint32_t>(X) + Seed * 0x9E3779B9U, static_cast<uint32_t>(Y), static_cast<uint32_t>(Z));
}

/** Gradient (Perlin) noise, about [-1, 1] and zero at every lattice point. */
inline double Perlin3(double X, double Y, double Z, uint32_t Seed)
{
	const double Fx = std::floor(X);
	const double Fy = std::floor(Y);
	const double Fz = std::floor(Z);
	const int Ix = static_cast<int>(Fx);
	const int Iy = static_cast<int>(Fy);
	const int Iz = static_cast<int>(Fz);
	const double Dx = X - Fx;
	const double Dy = Y - Fy;
	const double Dz = Z - Fz;
	const double U = Fade5(Dx);
	const double V = Fade5(Dy);
	const double W = Fade5(Dz);
	const double C000 = Grad3(Lat3(Ix, Iy, Iz, Seed), Dx, Dy, Dz);
	const double C100 = Grad3(Lat3(Ix + 1, Iy, Iz, Seed), Dx - 1.0, Dy, Dz);
	const double C010 = Grad3(Lat3(Ix, Iy + 1, Iz, Seed), Dx, Dy - 1.0, Dz);
	const double C110 = Grad3(Lat3(Ix + 1, Iy + 1, Iz, Seed), Dx - 1.0, Dy - 1.0, Dz);
	const double C001 = Grad3(Lat3(Ix, Iy, Iz + 1, Seed), Dx, Dy, Dz - 1.0);
	const double C101 = Grad3(Lat3(Ix + 1, Iy, Iz + 1, Seed), Dx - 1.0, Dy, Dz - 1.0);
	const double C011 = Grad3(Lat3(Ix, Iy + 1, Iz + 1, Seed), Dx, Dy - 1.0, Dz - 1.0);
	const double C111 = Grad3(Lat3(Ix + 1, Iy + 1, Iz + 1, Seed), Dx - 1.0, Dy - 1.0, Dz - 1.0);
	const double X00 = Lerp(C000, C100, U);
	const double X10 = Lerp(C010, C110, U);
	const double X01 = Lerp(C001, C101, U);
	const double X11 = Lerp(C011, C111, U);
	return Lerp(Lerp(X00, X10, V), Lerp(X01, X11, V), W) * 0.82;
}

/** Fractal noise, about [-1, 1]: each octave `Lacunarity` times finer and `Gain` times as strong, and turned a little. */
inline double Fbm3(double X, double Y, double Z, int Octaves, uint32_t Seed, double Lacunarity = 2.0, double Gain = 0.5)
{
	double Sum = 0.0;
	double Amp = 1.0;
	double Norm = 0.0;
	for (int O = 0; O < Octaves; ++O)
	{
		Sum += Amp * Perlin3(X, Y, Z, Seed + static_cast<uint32_t>(O) * 131U);
		Norm += Amp;
		// A fixed turn between octaves keeps the lattice's axes from showing.
		const double Nx = 0.80 * X - 0.60 * Y + 0.0 * Z;
		const double Ny = 0.48 * X + 0.64 * Y - 0.60 * Z;
		const double Nz = 0.36 * X + 0.48 * Y + 0.80 * Z;
		X = Nx * Lacunarity + 13.7;
		Y = Ny * Lacunarity - 7.3;
		Z = Nz * Lacunarity + 3.1;
		Amp *= Gain;
	}
	return Sum / Norm;
}

/** Ridged noise in [0, 1]: thin bright creases where the underlying noise crosses zero (filaments, veins). */
inline double Ridged3(double X, double Y, double Z, int Octaves, uint32_t Seed, double Lacunarity = 2.0, double Gain = 0.55)
{
	double Sum = 0.0;
	double Amp = 1.0;
	double Norm = 0.0;
	for (int O = 0; O < Octaves; ++O)
	{
		const double R = 1.0 - std::fabs(Perlin3(X, Y, Z, Seed + static_cast<uint32_t>(O) * 211U));
		Sum += Amp * R * R;
		Norm += Amp;
		const double Nx = 0.80 * X - 0.60 * Y;
		const double Ny = 0.48 * X + 0.64 * Y - 0.60 * Z;
		const double Nz = 0.36 * X + 0.48 * Y + 0.80 * Z;
		X = Nx * Lacunarity + 5.3;
		Y = Ny * Lacunarity - 2.9;
		Z = Nz * Lacunarity + 8.7;
		Amp *= Gain;
	}
	return Sum / Norm;
}

/** Distances to the nearest and second nearest of a jittered point per unit cell: convection cells, scales, cracks. */
struct Cells
{
	double F1 = 0.0;
	double F2 = 0.0;
	/** A number in [0, 1) that belongs to the nearest cell (its own brightness, say). */
	double Id = 0.0;
};

inline Cells Worley3(double X, double Y, double Z, uint32_t Seed)
{
	const double Fx = std::floor(X);
	const double Fy = std::floor(Y);
	const double Fz = std::floor(Z);
	const int Ix = static_cast<int>(Fx);
	const int Iy = static_cast<int>(Fy);
	const int Iz = static_cast<int>(Fz);
	Cells Out;
	Out.F1 = 8.0;
	Out.F2 = 8.0;
	for (int Dz = -1; Dz <= 1; ++Dz)
	{
		for (int Dy = -1; Dy <= 1; ++Dy)
		{
			for (int Dx = -1; Dx <= 1; ++Dx)
			{
				const int Cx = Ix + Dx;
				const int Cy = Iy + Dy;
				const int Cz = Iz + Dz;
				const uint32_t H = Lat3(Cx, Cy, Cz, Seed);
				const double Px = static_cast<double>(Cx) + 0.15 + 0.7 * Hash01(H, 1U);
				const double Py = static_cast<double>(Cy) + 0.15 + 0.7 * Hash01(H, 2U);
				const double Pz = static_cast<double>(Cz) + 0.15 + 0.7 * Hash01(H, 3U);
				const double Ex = Px - X;
				const double Ey = Py - Y;
				const double Ez = Pz - Z;
				const double D = std::sqrt(Ex * Ex + Ey * Ey + Ez * Ez);
				if (D < Out.F1)
				{
					Out.F2 = Out.F1;
					Out.F1 = D;
					Out.Id = Hash01(H, 4U);
				}
				else if (D < Out.F2)
				{
					Out.F2 = D;
				}
			}
		}
	}
	return Out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Colour                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

struct Rgb
{
	double R = 0.0;
	double G = 0.0;
	double B = 0.0;
};

inline Rgb operator*(const Rgb& A, double S) { return {A.R * S, A.G * S, A.B * S}; }
inline Rgb operator+(const Rgb& A, const Rgb& B) { return {A.R + B.R, A.G + B.G, A.B + B.B}; }
inline Rgb Mul(const Rgb& A, const Rgb& B) { return {A.R * B.R, A.G * B.G, A.B * B.B}; }
inline Rgb LerpRgb(const Rgb& A, const Rgb& B, double T) { return {Lerp(A.R, B.R, T), Lerp(A.G, B.G, T), Lerp(A.B, B.B, T)}; }

inline double Srgb8ToLinear(double S)
{
	return S <= 0.04045 ? S / 12.92 : std::pow((S + 0.055) / 1.055, 2.4);
}

/**
 * The colour of a black body, in linear sRGB with the brightest channel at 1 (Tanner Helland's fit, good from about
 * 1,500 to 40,000 K): 3,000 K is a red dwarf, 5,800 K our Sun, 10,000 K and more the blue-white giants.
 */
inline Rgb Blackbody(double Kelvin)
{
	const double T = Clamp(Kelvin, 1000.0, 40000.0) / 100.0;
	double R = 0.0;
	double G = 0.0;
	double B = 0.0;
	if (T <= 66.0)
	{
		R = 255.0;
		G = Clamp(99.4708025861 * std::log(T) - 161.1195681661, 0.0, 255.0);
		B = T <= 19.0 ? 0.0 : Clamp(138.5177312231 * std::log(T - 10.0) - 305.0447927307, 0.0, 255.0);
	}
	else
	{
		R = Clamp(329.698727446 * std::pow(T - 60.0, -0.1332047592), 0.0, 255.0);
		G = Clamp(288.1221695283 * std::pow(T - 60.0, -0.0755148492), 0.0, 255.0);
		B = 255.0;
	}
	Rgb C{Srgb8ToLinear(R / 255.0), Srgb8ToLinear(G / 255.0), Srgb8ToLinear(B / 255.0)};
	const double M = std::max(C.R, std::max(C.G, C.B));
	return M > 0.0 ? C * (1.0 / M) : C;
}

/** Linear light to an sRGB byte through a lookup table (a pow per channel per pixel is too slow at 33 million pixels). */
class SrgbLut
{
public:
	SrgbLut()
	{
		Table.resize(kSize + 1);
		for (int I = 0; I <= kSize; ++I)
		{
			const double L = static_cast<double>(I) / static_cast<double>(kSize);
			Table[static_cast<size_t>(I)] = static_cast<float>(L <= 0.0031308 ? 12.92 * L : 1.055 * std::pow(L, 1.0 / 2.4) - 0.055);
		}
	}

	/** The sRGB value in [0, 255] (not rounded, so the caller can dither before it rounds). */
	double Encode(double Linear) const
	{
		const double X = Clamp01(Linear) * static_cast<double>(kSize);
		const int I = std::min(static_cast<int>(X), kSize - 1);
		const double T = X - static_cast<double>(I);
		return Lerp(static_cast<double>(Table[static_cast<size_t>(I)]), static_cast<double>(Table[static_cast<size_t>(I) + 1U]), T) * 255.0;
	}

private:
	static constexpr int kSize = 8192;
	std::vector<float> Table;
};

inline const SrgbLut& Lut()
{
	static const SrgbLut Instance;
	return Instance;
}

/** Writes linear light as an sRGB BGRA pixel, adding a different sub-level of noise per pixel (dither) before rounding. */
inline void PutDithered(Image& Img, int X, int Y, double R, double G, double B)
{
	const size_t O = Img.Offset(X, Y);
	const uint32_t H = HashU(static_cast<uint32_t>(X), static_cast<uint32_t>(Y), 0xD17E5U);
	const double D0 = (static_cast<double>(H & 0xFFFFU) / 65536.0) - 0.5;
	const double D1 = (static_cast<double>((H >> 16) & 0xFFFFU) / 65536.0) - 0.5;
	const double D2 = (static_cast<double>(AetherSpace::Mix(H) & 0xFFFFU) / 65536.0) - 0.5;
	const SrgbLut& L = Lut();
	const double Sb = L.Encode(B) + D0;
	const double Sg = L.Encode(G) + D1;
	const double Sr = L.Encode(R) + D2;
	Img.Bgra[O + 0] = static_cast<uint8_t>(Clamp(Sb + 0.5, 0.0, 255.0));
	Img.Bgra[O + 1] = static_cast<uint8_t>(Clamp(Sg + 0.5, 0.0, 255.0));
	Img.Bgra[O + 2] = static_cast<uint8_t>(Clamp(Sr + 0.5, 0.0, 255.0));
	Img.Bgra[O + 3] = 255;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Directions on the sphere                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The direction a pixel of an equirectangular picture looks at (Unreal's axes: Z up; longitude 0 along +X). */
inline Vec3 EquirectDir(int X, int Y, int Width, int Height)
{
	const double Lon = (static_cast<double>(X) + 0.5) / static_cast<double>(Width) * kTwoPi - kPi;
	const double Lat = kPi * 0.5 - (static_cast<double>(Y) + 0.5) / static_cast<double>(Height) * kPi;
	const double C = std::cos(Lat);
	return {C * std::cos(Lon), C * std::sin(Lon), std::sin(Lat)};
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The sky                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

struct SkyParams
{
	int Width = 8192;
	int Height = 4096;
	uint32_t Seed = 2026U;
	/** 0 = a plain star field, 1 = as designed, up to 2 = more and brighter gas. */
	double Nebula = 1.0;
	/** Multiplies how many stars there are (1 = tens of thousands at 8K). */
	double StarDensity = 1.0;
	/** The base fields (the gas) are made at 1/BaseDiv of the size and sharpened at full size. */
	int BaseDiv = 4;
	/** 0 = all cores. */
	unsigned Threads = 0U;
};

/** The three colours of the gas: ionised hydrogen, doubly ionised oxygen, sulphur, and the blue of starlight scattered by dust. */
constexpr Rgb kHAlpha{1.00, 0.16, 0.20};
constexpr Rgb kOxygen{0.10, 0.80, 0.95};
constexpr Rgb kSulphur{1.00, 0.42, 0.08};
constexpr Rgb kReflection{0.30, 0.48, 1.00};

inline Vec3 GalacticNormal() { return AetherSpace::BandNormal(); }

/** One cell-grid layer of stars on the sphere: how big the cells are, how many cells hold a star, how bright they are. */
struct StarLevel
{
	/** Cell edge, radians. */
	double Cell;
	/** Chance that a cell holds a star. */
	double Chance;
	/** Brightness scale of its stars (linear light at the centre of the brightest). */
	double Flux;
	/** Exponent of the brightness distribution: higher = fewer bright ones. */
	double Power;
	/** Radius of a star in pixels (sigma). */
	double SigmaPx;
	/** Share of light in the wide halo. */
	double Halo;
};

/** Stars in the picture's cell at (Lon, Lat); adds their light, tinted by temperature, into Out. */
inline void AddStars(const StarLevel& L, double Lon, double Lat, double PixelAngle, uint32_t Seed, double Density, Rgb& Out)
{
	const double Row = std::floor((Lat + kPi * 0.5) / L.Cell);
	const double LatC = (Row + 0.5) * L.Cell - kPi * 0.5;
	const double Around = std::max(1.0, std::floor(kTwoPi * std::cos(LatC) / L.Cell));
	const double Col = std::floor(Lon / kTwoPi * Around);
	const uint32_t H = HashU(static_cast<uint32_t>(static_cast<int>(Row)), static_cast<uint32_t>(static_cast<int>(Col)), Seed);
	if (Hash01(H, 11U) > L.Chance * Density)
	{
		return;
	}
	const double CenterLat = (Row + 0.25 + 0.5 * Hash01(H, 12U)) * L.Cell - kPi * 0.5;
	const double CenterLon = (Col + 0.25 + 0.5 * Hash01(H, 13U)) * (kTwoPi / Around);
	double Dlon = Lon - CenterLon;
	if (Dlon > kPi)
	{
		Dlon -= kTwoPi;
	}
	if (Dlon < -kPi)
	{
		Dlon += kTwoPi;
	}
	const double Dlat = Lat - CenterLat;
	const double Dx = Dlon * std::cos(CenterLat);
	const double D2 = Dx * Dx + Dlat * Dlat;
	const double Brightness = std::pow(Hash01(H, 14U), L.Power);
	const double Sigma = PixelAngle * L.SigmaPx * (0.85 + 0.9 * Brightness);
	// A star's picture stops well inside its cell (Window), so neighbouring cells never have to be asked.
	const double Reach = 0.24 * L.Cell;
	const double Core = std::exp(-D2 / (2.0 * Sigma * Sigma));
	const double HaloSigma = Sigma * 3.5;
	const double Halo = L.Halo * Brightness * std::exp(-D2 / (2.0 * HaloSigma * HaloSigma));
	const double D = std::sqrt(D2);
	const double Window = 1.0 - Smoothstep(Reach * 0.55, Reach, D);
	if (Window <= 0.0)
	{
		return;
	}
	// Temperature: most stars are cool and orange, a few are blue-white.
	const double Pick = Hash01(H, 15U);
	const double Kelvin = Pick < 0.55 ? Lerp(3200.0, 5200.0, Pick / 0.55) : (Pick < 0.88 ? Lerp(5200.0, 7400.0, (Pick - 0.55) / 0.33) : Lerp(7400.0, 16000.0, (Pick - 0.88) / 0.12));
	const Rgb Tint = LerpRgb(Rgb{1.0, 1.0, 1.0}, Blackbody(Kelvin), 0.8);
	const double Light = L.Flux * (0.04 + Brightness) * (Core + Halo) * Window;
	Out = Out + Tint * Light;
}

/**
 * The sky as an equirectangular picture: gas and dust lit in four colours, a galactic band that brightens toward its
 * core, and stars at three scales. Seamless left to right (all the noise is 3D, taken on the sphere).
 */
inline Image MakeSkyMap(const SkyParams& P)
{
	const int W = std::max(64, P.Width);
	const int H = std::max(32, P.Height);
	const int Div = std::max(1, P.BaseDiv);
	const int Bw = std::max(16, W / Div);
	const int Bh = std::max(8, H / Div);
	const uint32_t S = P.Seed;
	const Vec3 Band = GalacticNormal();
	const Vec3 Core = AetherSpace::Normalized(AetherSpace::Vec3{0.62, 0.55, 0.02});

	// Pass 1, at a quarter of the size: the gas (colour), how much starlight the dust lets through, and the band's glow.
	struct Cell4
	{
		float R, G, B, Transmit;
	};
	std::vector<Cell4> Base(static_cast<size_t>(Bw) * static_cast<size_t>(Bh));
	// A smooth step through a noise field, so each colour of gas lives in its own large regions of the sky.
	auto Region = [&](const Vec3& D, double Freq, double Off, uint32_t Salt, double Lo, double Hi) {
		return Smoothstep(Lo, Hi, 0.5 + 0.5 * Fbm3(D.X * Freq + Off, D.Y * Freq - Off, D.Z * Freq + 2.0 * Off, 3, S + Salt));
	};
	ParallelRows(
		Bh,
		[&](int Y) {
			for (int X = 0; X < Bw; ++X)
			{
				const Vec3 D = EquirectDir(X, Y, Bw, Bh);
				const double Sin = AetherSpace::Dot(D, Band);
				// The galactic band: broad, with a ragged edge.
				const double Edge = 1.0 + 0.45 * Fbm3(D.X * 2.5, D.Y * 2.5, D.Z * 2.5, 4, S + 3U);
				const double Gal = std::exp(-(Sin * Sin * Edge * Edge) / (2.0 * 0.17 * 0.17));
				const double Bulge = std::exp(-std::acos(Clamp(AetherSpace::Dot(D, Core), -1.0, 1.0)) * 1.6);
				// Where the sky is rich: along the band, and in a few large complexes off it. Everywhere else it is nearly black.
				const double Patch = Region(D, 0.9, 0.0, 5U, 0.52, 0.80);
				const double Rich = Clamp01(0.75 * Gal + 1.25 * Patch * Patch);
				// The gas flows: a domain warp.
				const double Wx = Fbm3(D.X * 1.3 + 3.0, D.Y * 1.3, D.Z * 1.3, 4, S + 11U);
				const double Wy = Fbm3(D.X * 1.3, D.Y * 1.3 + 5.0, D.Z * 1.3, 4, S + 17U);
				const double Wz = Fbm3(D.X * 1.3, D.Y * 1.3, D.Z * 1.3 + 7.0, 4, S + 23U);
				const double Qx = D.X * 2.4 + 1.25 * Wx;
				const double Qy = D.Y * 2.4 + 1.25 * Wy;
				const double Qz = D.Z * 2.4 + 1.25 * Wz;
				const double Core3 = 0.5 + 0.5 * Fbm3(Qx, Qy, Qz, 7, S + 31U);
				const double Knots = std::pow(Ridged3(Qx * 1.15, Qy * 1.15, Qz * 1.15, 4, S + 47U), 2.6);
				// Each gas in its own regions; where two overlap they mix (purples, whites).
				const double MaskHa = Region(D, 1.1, 1.0, 71U, 0.46, 0.74);
				const double MaskOx = Region(D, 1.1, 5.0, 73U, 0.48, 0.76);
				const double MaskSu = Region(D, 1.3, 9.0, 79U, 0.55, 0.80);
				const double MaskRf = Region(D, 1.0, 13.0, 83U, 0.50, 0.78);
				const double Ha = std::pow(Smoothstep(0.34, 0.84, Core3), 2.0) * (0.35 + 1.25 * Knots) * MaskHa;
				const double Ox = std::pow(Smoothstep(0.36, 0.88, 0.5 + 0.5 * Fbm3(Qx * 1.25 + 9.0, Qy * 1.25, Qz * 1.25, 6, S + 37U)), 2.0) * (0.30 + 1.1 * Knots) * MaskOx;
				const double Su = std::pow(Smoothstep(0.40, 0.90, 0.5 + 0.5 * Fbm3(Qx * 1.6, Qy * 1.6 + 4.0, Qz * 1.6, 5, S + 41U)), 2.2) * MaskSu;
				const double Rf = std::pow(Smoothstep(0.30, 0.90, 0.5 + 0.5 * Fbm3(Qx * 0.8 - 5.0, Qy * 0.8, Qz * 0.8 + 2.0, 5, S + 53U)), 1.8) * MaskRf * (0.4 + 0.6 * Gal);
				// Dust: dark lanes through the band and the nebulae; they hide the gas and the stars behind them.
				const double DustField = Smoothstep(0.42, 0.80, 0.5 + 0.5 * Fbm3(Qx * 1.15 + 2.0, Qy * 1.15 - 3.0, Qz * 1.15, 7, S + 59U));
				const double Dust = DustField * (0.20 + 1.1 * Gal + 0.5 * Rich);
				const double Transmit = std::exp(-4.2 * Dust);

				const double Amount = P.Nebula * Rich;
				Rgb Gas = kHAlpha * (1.15 * Ha) + kOxygen * (0.95 * Ox) + kSulphur * (0.60 * Su) + kReflection * (0.70 * Rf);
				Gas = Gas * (Amount * 2.1);
				// The glow of unresolved starlight in the band, warm toward the core, broken by the dust.
				const double Glow = (0.08 + 0.75 * Bulge) * Gal * (0.35 + 0.65 * (0.5 + 0.5 * Fbm3(D.X * 3.2, D.Y * 3.2, D.Z * 3.2, 4, S + 67U)));
				const Rgb Warm = LerpRgb(Rgb{0.78, 0.86, 1.00}, Rgb{1.00, 0.80, 0.50}, Clamp01(Bulge * 1.5));
				const Rgb Total = (Gas + Warm * (Glow * 0.42)) * (0.10 + 0.90 * Transmit);
				Cell4& C = Base[static_cast<size_t>(Y) * static_cast<size_t>(Bw) + static_cast<size_t>(X)];
				C.R = static_cast<float>(Total.R);
				C.G = static_cast<float>(Total.G);
				C.B = static_cast<float>(Total.B);
				C.Transmit = static_cast<float>(Transmit);
			}
		},
		P.Threads);

	// Pass 2, at full size: sample the base (bilinear, wrapping in longitude), sharpen the gas with fine filaments, add the
	// stars, tone-map and dither.
	Image Img(W, H);
	const double PixelAngle = kTwoPi / static_cast<double>(W);
	const StarLevel Faint{0.016, 0.50, 0.55, 3.2, 0.75, 0.05};
	const StarLevel Mid{0.045, 0.55, 1.50, 3.0, 0.9, 0.10};
	const StarLevel Bright{0.120, 0.60, 5.00, 2.6, 1.1, 0.18};
	ParallelRows(
		H,
		[&](int Y) {
			const double Lat = kPi * 0.5 - (static_cast<double>(Y) + 0.5) / static_cast<double>(H) * kPi;
			const double By = Clamp((static_cast<double>(Y) + 0.5) / static_cast<double>(H) * static_cast<double>(Bh) - 0.5, 0.0, static_cast<double>(Bh - 1));
			const int By0 = static_cast<int>(By);
			const int By1 = std::min(By0 + 1, Bh - 1);
			const double Ty = By - static_cast<double>(By0);
			for (int X = 0; X < W; ++X)
			{
				const double Lon = (static_cast<double>(X) + 0.5) / static_cast<double>(W) * kTwoPi;
				const double Bx = (static_cast<double>(X) + 0.5) / static_cast<double>(W) * static_cast<double>(Bw) - 0.5;
				const int Bx0 = static_cast<int>(std::floor(Bx));
				const double Tx = Bx - static_cast<double>(Bx0);
				const int X0 = ((Bx0 % Bw) + Bw) % Bw;
				const int X1 = (X0 + 1) % Bw;
				auto At = [&](int Cx, int Cy) -> const Cell4& { return Base[static_cast<size_t>(Cy) * static_cast<size_t>(Bw) + static_cast<size_t>(Cx)]; };
				double Acc[4] = {0.0, 0.0, 0.0, 0.0};
				const double Wt[4] = {(1.0 - Tx) * (1.0 - Ty), Tx * (1.0 - Ty), (1.0 - Tx) * Ty, Tx * Ty};
				const Cell4* Q[4] = {&At(X0, By0), &At(X1, By0), &At(X0, By1), &At(X1, By1)};
				for (int K = 0; K < 4; ++K)
				{
					Acc[0] += Wt[K] * static_cast<double>(Q[K]->R);
					Acc[1] += Wt[K] * static_cast<double>(Q[K]->G);
					Acc[2] += Wt[K] * static_cast<double>(Q[K]->B);
					Acc[3] += Wt[K] * static_cast<double>(Q[K]->Transmit);
				}
				Rgb Light{Acc[0], Acc[1], Acc[2]};
				const double Transmit = Acc[3];
				const double Brightness = (Light.R + Light.G + Light.B) / 3.0;
				const Vec3 D = EquirectDir(X, Y, W, H);
				if (Brightness > 0.003 && P.Nebula > 0.0)
				{
					// Fine structure the base cannot hold: filaments at three scales and grain, only where there is gas to carry it.
					const double Fil1 = Ridged3(D.X * 9.0, D.Y * 9.0, D.Z * 9.0, 2, S + 71U, 2.3, 0.5);
					const double Fil2 = Ridged3(D.X * 26.0, D.Y * 26.0, D.Z * 26.0, 2, S + 79U, 2.3, 0.5);
					const double Fil3 = Ridged3(D.X * 70.0, D.Y * 70.0, D.Z * 70.0, 2, S + 83U, 2.2, 0.5);
					const double Grain = 0.5 + 0.5 * Fbm3(D.X * 160.0, D.Y * 160.0, D.Z * 160.0, 2, S + 89U);
					const double Detail = 0.35 + 0.95 * Fil1 * (0.55 + 0.7 * Fil2) * (0.75 + 0.5 * Fil3) * (0.8 + 0.4 * Grain);
					Light = Light * Detail;
				}
				// Stars, thicker along the band, dimmed by the dust in front of them.
				const double Sin = AetherSpace::Dot(D, Band);
				const double Along = 0.55 + 1.6 * std::exp(-(Sin * Sin) / (2.0 * 0.2 * 0.2));
				Rgb Stars;
				AddStars(Faint, Lon, Lat, PixelAngle, S + 101U, P.StarDensity * Along, Stars);
				AddStars(Mid, Lon, Lat, PixelAngle, S + 103U, P.StarDensity * (0.5 + 0.5 * Along), Stars);
				AddStars(Bright, Lon, Lat, PixelAngle, S + 107U, P.StarDensity, Stars);
				Light = Light + Stars * (0.30 + 0.70 * Transmit);
				// A faint cool floor so the black is not flat, then a soft filmic shoulder (bright cores roll off, they do not clip).
				Light = Light + Rgb{0.0010, 0.0012, 0.0020};
				const double Sh = 1.0;
				const double R = 1.0 - std::exp(-Sh * 1.45 * Light.R);
				const double G = 1.0 - std::exp(-Sh * 1.45 * Light.G);
				const double B = 1.0 - std::exp(-Sh * 1.45 * Light.B);
				PutDithered(Img, X, Y, R, G, B);
			}
		},
		P.Threads);
	return Img;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Suns                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

struct SunParams
{
	int Width = 8192;
	int Height = 4096;
	uint32_t Seed = 1U;
	/** Surface temperature: 3,200 a red dwarf, 5,800 a Sun, 9,000 and more blue-white. */
	double Kelvin = 5800.0;
	/** 0 = a clean surface, 1 = as designed, 2 = a very active star. */
	double Activity = 1.0;
	unsigned Threads = 0U;
};

/**
 * The surface of a star as an equirectangular picture: convection cells (bright cores, dark lanes) at two scales with
 * a slow swirl, supergranulation, sunspots with umbra and fibrous penumbra, and bright faculae around them. Light and
 * colour only: the limb darkening and the glow are the material's job (the picture is meant to be shown with an
 * emissive multiplier of 5-10). Seamless left to right.
 */
inline Image MakeSunMap(const SunParams& P)
{
	const int W = std::max(64, P.Width);
	const int H = std::max(32, P.Height);
	const uint32_t S = P.Seed;
	const Rgb Hot = Blackbody(P.Kelvin);
	// The photosphere reads orange-yellow, not white: the lanes between cells are deep orange, the cell cores pale yellow.
	const Rgb Cool = Mul(Hot, Rgb{1.00, 0.52, 0.22});
	const Rgb Mid = Mul(Hot, Rgb{1.00, 0.84, 0.58});
	const Rgb White = LerpRgb(Hot, Rgb{1.0, 1.0, 0.96}, 0.45);
	// The spots: a few groups at mid latitudes, each a big umbra with smaller companions.
	struct Spot
	{
		Vec3 Dir;
		double Umbra;
	};
	std::vector<Spot> Spots;
	AetherSpace::Rng R(S * 7919U + 13U);
	const int Groups = static_cast<int>(std::round(3.0 + 5.0 * P.Activity));
	for (int G = 0; G < Groups; ++G)
	{
		const double Lat = (R.Next() * 2.0 - 1.0) * AetherSpace::DegToRad(32.0);
		const double Lon = R.Next() * kTwoPi;
		const Vec3 Center{std::cos(Lat) * std::cos(Lon), std::cos(Lat) * std::sin(Lon), std::sin(Lat)};
		const int Count = 1 + static_cast<int>(R.Next() * 4.0);
		for (int K = 0; K < Count; ++K)
		{
			const double Ox = (R.Next() - 0.5) * 0.22;
			const double Oy = (R.Next() - 0.5) * 0.14;
			Vec3 D = AetherSpace::Normalized(Center + Vec3{-std::sin(Lon) * Ox, std::cos(Lon) * Ox, 0.0} + Vec3{0.0, 0.0, Oy});
			Spots.push_back({D, (K == 0 ? 0.035 : 0.015) * (0.7 + 0.8 * R.Next())});
		}
	}

	Image Img(W, H);
	ParallelRows(
		H,
		[&](int Y) {
			for (int X = 0; X < W; ++X)
			{
				const Vec3 D = EquirectDir(X, Y, W, H);
				// Swirl and warp so the cells are not a perfect honeycomb.
				const double Wx = Perlin3(D.X * 9.0 + 2.0, D.Y * 9.0, D.Z * 9.0, S + 3U);
				const double Wy = Perlin3(D.X * 9.0, D.Y * 9.0 + 4.0, D.Z * 9.0, S + 5U);
				const double Wz = Perlin3(D.X * 9.0, D.Y * 9.0, D.Z * 9.0 + 6.0, S + 7U);
				const double Px = D.X + 0.020 * Wx;
				const double Py = D.Y + 0.020 * Wy;
				const double Pz = D.Z + 0.020 * Wz;
				// Granulation at two scales.
				const Cells C1 = Worley3(Px * 70.0, Py * 70.0, Pz * 70.0, S + 11U);
				const Cells C2 = Worley3(Px * 190.0, Py * 190.0, Pz * 190.0, S + 13U);
				const double Core1 = 1.0 - Smoothstep(0.0, 0.62, C1.F1);
				const double Lane1 = Smoothstep(0.015, 0.20, C1.F2 - C1.F1);
				const double Core2 = 1.0 - Smoothstep(0.0, 0.60, C2.F1);
				const double Lane2 = Smoothstep(0.02, 0.22, C2.F2 - C2.F1);
				// Big soft cells carry the picture; the fine lanes are a light touch, so it reads as a photograph, not a mesh.
				const double Gran = 0.72 * (0.7 * Core1 + 0.3 * Lane1) + 0.28 * (0.6 * Core2 + 0.4 * Lane2);
				const double CellTone = 0.84 + 0.32 * C1.Id;
				const double Super = 0.5 + 0.5 * Fbm3(D.X * 4.0, D.Y * 4.0, D.Z * 4.0, 3, S + 17U);
				double Intensity = (0.34 + 0.80 * Gran) * CellTone * (0.86 + 0.28 * Super);

				// Spots and the bright network around them.
				double Umbra = 0.0;
				double Penumbra = 0.0;
				double Facula = 0.0;
				for (const Spot& Sp : Spots)
				{
					const double Dot = Clamp(AetherSpace::Dot(D, Sp.Dir), -1.0, 1.0);
					if (Dot < 0.95)
					{
						continue;
					}
					const double Ang = std::acos(Dot);
					const double Fibre = 0.65 + 0.35 * Perlin3(D.X * 160.0, D.Y * 160.0, D.Z * 160.0, S + 19U);
					Umbra = std::max(Umbra, 1.0 - Smoothstep(Sp.Umbra * 0.55, Sp.Umbra, Ang));
					Penumbra = std::max(Penumbra, (1.0 - Smoothstep(Sp.Umbra * 1.0, Sp.Umbra * 2.1, Ang)) * Fibre);
					Facula = std::max(Facula, (1.0 - Smoothstep(Sp.Umbra * 2.0, Sp.Umbra * 5.5, Ang)) * (0.4 + 0.6 * Smoothstep(0.3, 0.8, 0.5 + 0.5 * Perlin3(D.X * 60.0, D.Y * 60.0, D.Z * 60.0, S + 23U))));
				}
				Intensity *= 1.0 + 0.32 * Facula;
				Intensity = Lerp(Intensity, Intensity * 0.42, Clamp01(Penumbra));
				Intensity = Lerp(Intensity, Intensity * 0.10, Clamp01(Umbra));

				// Colour by brightness: lanes deep orange, cells yellow, their cores pale.
				const double Heat = Clamp01((Intensity - 0.12) / 0.95);
				Rgb Col = Heat < 0.5 ? LerpRgb(Cool, Mid, Heat / 0.5) : (Heat < 0.8 ? LerpRgb(Mid, Hot, (Heat - 0.5) / 0.3) : LerpRgb(Hot, White, (Heat - 0.8) / 0.2));
				Col = Col * (0.35 + 0.95 * Intensity);
				// The map is shown with an emissive multiplier: keep it in range, with a soft shoulder.
				PutDithered(Img, X, Y, 1.0 - std::exp(-0.95 * Col.R), 1.0 - std::exp(-0.95 * Col.G), 1.0 - std::exp(-0.95 * Col.B));
			}
		},
		P.Threads);
	return Img;
}

/**
 * The glow around a star, a square picture with the star in the middle: a bright inner halo, long streamers that thin
 * out, a faint wide haze. Meant for an additive, camera-facing sprite; the disc itself is hidden behind the sphere.
 */
inline Image MakeCorona(int Size, uint32_t Seed, double Kelvin, double Streamers = 1.0)
{
	const int N = std::max(64, Size);
	const Rgb Hot = Blackbody(Kelvin);
	// Warm, not white: the inner glow is the star's colour, the far streamers cool toward it.
	const Rgb Tint = LerpRgb(Hot, Rgb{1.0, 0.86, 0.66}, 0.20);
	Image Img(N, N);
	ParallelRows(N, [&](int Y) {
		for (int X = 0; X < N; ++X)
		{
			const double U = (static_cast<double>(X) + 0.5) / static_cast<double>(N) * 2.0 - 1.0;
			const double V = (static_cast<double>(Y) + 0.5) / static_cast<double>(N) * 2.0 - 1.0;
			const double Rr = std::sqrt(U * U + V * V);
			// The star's own disc has radius 0.16 of the picture's half-width.
			const double Rin = 0.16;
			if (Rr < Rin * 0.85)
			{
				PutDithered(Img, X, Y, 0.0, 0.0, 0.0);
				continue;
			}
			const double Theta = std::atan2(V, U);
			const double Cx = std::cos(Theta);
			const double Sy = std::sin(Theta);
			// Streamers: noise around the circle, stretched along the radius, slowly turning with radius.
			const double Rays = 0.5 + 0.5 * Fbm3(Cx * 2.6, Sy * 2.6, Rr * 1.3, 5, Seed + 5U);
			const double Fine = 0.5 + 0.5 * Fbm3(Cx * 9.0, Sy * 9.0, Rr * 2.0 + 3.0, 3, Seed + 9U);
			const double Streak = std::pow(Rays, 2.2) * (0.55 + 0.45 * Fine);
			const double X1 = (Rr - Rin) / (1.0 - Rin);
			const double Inner = std::exp(-6.0 * std::max(0.0, Rr - Rin));
			const double Falloff = std::pow(1.0 - Smoothstep(0.0, 1.0, X1), 2.2);
			const double Haze = 0.35 * std::exp(-3.0 * std::max(0.0, Rr - Rin)) * Falloff;
			const double Edge = 1.0 - Smoothstep(0.82, 1.0, Rr);
			const double Light = (0.95 * Inner + Streamers * 1.4 * Streak * Falloff + Haze) * Edge * Smoothstep(Rin * 0.85, Rin * 1.15, Rr);
			PutDithered(Img, X, Y, Tint.R * Light, Tint.G * Light, Tint.B * Light);
		}
	});
	return Img;
}

} // namespace AetherSky
