// Tests for the photographic sky, sun and corona pictures (AetherSkyMath.h). Plain C++, no Unreal: run with unreal/tests/run.sh
// The pictures are made small here (the real ones are 8192 x 4096): what is checked is what does not depend on size.
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherSkyMath.h"

#include <cstdio>

using namespace AetherSky;
using AetherSpace::Image;

static int Failures = 0;
static int Checks = 0;

#define CHECK(Cond)                                                                                         \
	do                                                                                                      \
	{                                                                                                       \
		++Checks;                                                                                           \
		if (!(Cond))                                                                                        \
		{                                                                                                   \
			++Failures;                                                                                     \
			std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #Cond);                                     \
		}                                                                                                   \
	} while (0)

static double Luma(const Image& I, int X, int Y)
{
	double R = 0.0;
	double G = 0.0;
	double B = 0.0;
	I.Get(X, Y, R, G, B);
	return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

struct Stats
{
	double MeanLuma = 0.0;
	double MeanR = 0.0;
	double MeanG = 0.0;
	double MeanB = 0.0;
	double MaxLuma = 0.0;
	double DarkShare = 0.0;   // share of pixels under a quarter of the mean
	double ClippedShare = 0.0; // share of pixels with a channel at 255
	double Chroma = 0.0;      // share of pixels with a clearly coloured hue
	bool AllOpaque = true;
};

static Stats Measure(const Image& I)
{
	Stats S;
	const double N = static_cast<double>(I.Width) * static_cast<double>(I.Height);
	size_t Dark = 0;
	size_t Clip = 0;
	size_t Coloured = 0;
	std::vector<double> Ls;
	Ls.reserve(static_cast<size_t>(N));
	for (int Y = 0; Y < I.Height; ++Y)
	{
		for (int X = 0; X < I.Width; ++X)
		{
			double R = 0.0;
			double G = 0.0;
			double B = 0.0;
			I.Get(X, Y, R, G, B);
			const double L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
			S.MeanR += R;
			S.MeanG += G;
			S.MeanB += B;
			S.MeanLuma += L;
			S.MaxLuma = std::max(S.MaxLuma, L);
			Ls.push_back(L);
			const size_t O = I.Offset(X, Y);
			if (I.Bgra[O + 3] != 255)
			{
				S.AllOpaque = false;
			}
			if (I.Bgra[O] == 255 || I.Bgra[O + 1] == 255 || I.Bgra[O + 2] == 255)
			{
				++Clip;
			}
			const double Hi = std::max(R, std::max(G, B));
			const double Lo = std::min(R, std::min(G, B));
			if (Hi > 0.02 && (Hi - Lo) > 0.4 * Hi)
			{
				++Coloured;
			}
		}
	}
	S.MeanR /= N;
	S.MeanG /= N;
	S.MeanB /= N;
	S.MeanLuma /= N;
	for (const double L : Ls)
	{
		if (L < 0.25 * S.MeanLuma)
		{
			++Dark;
		}
	}
	S.DarkShare = static_cast<double>(Dark) / N;
	S.ClippedShare = static_cast<double>(Clip) / N;
	S.Chroma = static_cast<double>(Coloured) / N;
	return S;
}

static SkyParams SmallSky(uint32_t Seed)
{
	SkyParams P;
	P.Width = 512;
	P.Height = 256;
	P.Seed = Seed;
	P.Threads = 2U;
	return P;
}

static SunParams SmallSun(uint32_t Seed, double Kelvin, double Activity = 1.0)
{
	SunParams P;
	P.Width = 256;
	P.Height = 128;
	P.Seed = Seed;
	P.Kelvin = Kelvin;
	P.Activity = Activity;
	P.Threads = 2U;
	return P;
}

/* ---------------------------------------------------------------------------------------------------------------- */

static void TestNoise()
{
	// Zero at the lattice, bounded, and the same twice.
	CHECK(std::fabs(Perlin3(3.0, 5.0, -2.0, 9U)) < 1e-12);
	double Lo = 1e9;
	double Hi = -1e9;
	for (int I = 0; I < 20000; ++I)
	{
		const double X = Hash01(static_cast<uint32_t>(I), 1U, 2U) * 40.0;
		const double Y = Hash01(static_cast<uint32_t>(I), 3U, 4U) * 40.0;
		const double Z = Hash01(static_cast<uint32_t>(I), 5U, 6U) * 40.0;
		const double P = Perlin3(X, Y, Z, 4U);
		const double F = Fbm3(X, Y, Z, 5, 4U);
		CHECK(P == Perlin3(X, Y, Z, 4U));
		CHECK(std::isfinite(P) && std::isfinite(F));
		Lo = std::min(Lo, F);
		Hi = std::max(Hi, F);
	}
	CHECK(Lo > -1.2 && Hi < 1.2);
	CHECK(Hi - Lo > 0.8); // it does vary
	// Cells: the nearest feature is no farther than the second nearest, and ids are unit.
	for (int I = 0; I < 4000; ++I)
	{
		const Cells C = Worley3(Hash01(static_cast<uint32_t>(I), 7U, 8U) * 30.0, Hash01(static_cast<uint32_t>(I), 9U, 1U) * 30.0, Hash01(static_cast<uint32_t>(I), 2U, 3U) * 30.0, 5U);
		CHECK(C.F1 <= C.F2 + 1e-12);
		CHECK(C.F1 >= 0.0 && C.F2 < 3.0);
		CHECK(C.Id >= 0.0 && C.Id <= 1.0);
	}
}

static void TestBlackbody()
{
	const Rgb Red = Blackbody(3200.0);
	const Rgb Sun = Blackbody(5800.0);
	const Rgb Blue = Blackbody(12000.0);
	CHECK(Red.R > Red.B * 1.8);
	CHECK(Blue.B > Blue.R);
	CHECK(Sun.R >= Sun.G && Sun.G >= Sun.B); // warm white
	CHECK(Sun.B > 0.7);                       // not orange
	for (double K = 1000.0; K <= 40000.0; K += 500.0)
	{
		const Rgb C = Blackbody(K);
		CHECK(std::isfinite(C.R) && std::isfinite(C.G) && std::isfinite(C.B));
		CHECK(C.R >= 0.0 && C.R <= 1.0001 && C.G >= 0.0 && C.G <= 1.0001 && C.B >= 0.0 && C.B <= 1.0001);
	}
	// Hotter is bluer.
	double Prev = -1.0;
	for (double K = 2000.0; K <= 15000.0; K += 1000.0)
	{
		const Rgb C = Blackbody(K);
		const double Ratio = C.B / std::max(1e-9, C.R);
		CHECK(Ratio >= Prev - 1e-9);
		Prev = Ratio;
	}
}

static void TestSky()
{
	const Image A = MakeSkyMap(SmallSky(11U));
	const Image B = MakeSkyMap(SmallSky(11U));
	const Image C = MakeSkyMap(SmallSky(12U));
	CHECK(A.Width == 512 && A.Height == 256);
	CHECK(A.Bgra == B.Bgra);  // the same seed, the same sky
	CHECK(A.Bgra != C.Bgra);  // another seed, another sky
	// The number of threads must not change a pixel.
	SkyParams One = SmallSky(11U);
	One.Threads = 1U;
	SkyParams Many = SmallSky(11U);
	Many.Threads = 5U;
	CHECK(MakeSkyMap(One).Bgra == MakeSkyMap(Many).Bgra);

	const Stats S = Measure(A);
	CHECK(S.AllOpaque);
	CHECK(S.MeanLuma > 0.002 && S.MeanLuma < 0.12); // space is dark, not black
	CHECK(S.MaxLuma > 0.5);                         // with stars in it
	CHECK(S.DarkShare > 0.3);                       // mostly empty
	CHECK(S.ClippedShare < 0.02);                   // and not a white-out
	CHECK(S.Chroma > 0.02);                         // gas has colour: more than a grey field
	// Both ends of the picture join: the seam is no rougher than any other pair of columns.
	double Seam = 0.0;
	double Inner = 0.0;
	for (int Y = 0; Y < A.Height; ++Y)
	{
		Seam += std::fabs(Luma(A, 0, Y) - Luma(A, A.Width - 1, Y));
		Inner += std::fabs(Luma(A, 255, Y) - Luma(A, 256, Y));
	}
	CHECK(Seam < Inner * 2.5 + 0.5);

	// Gas adds light; more stars add bright pixels.
	SkyParams NoGas = SmallSky(11U);
	NoGas.Nebula = 0.0;
	const Stats Bare = Measure(MakeSkyMap(NoGas));
	CHECK(Bare.MeanLuma < S.MeanLuma);
	SkyParams Dense = SmallSky(11U);
	Dense.StarDensity = 3.0;
	const Stats Crowded = Measure(MakeSkyMap(Dense));
	CHECK(Crowded.MeanLuma > S.MeanLuma);
	SkyParams None = SmallSky(11U);
	None.StarDensity = 0.0;
	None.Nebula = 0.0;
	// With neither stars nor gas only the soft glow of the galactic band is left: dim, with no point of light in it.
	CHECK(Measure(MakeSkyMap(None)).MaxLuma < 0.35);
	SkyParams Few = SmallSky(11U);
	Few.StarDensity = 0.1;
	Few.Nebula = 0.0;
	CHECK(Measure(MakeSkyMap(Few)).MaxLuma > 0.8); // one star is enough to be a point of light

	// Sizes that make no sense are made sensible instead of crashing.
	SkyParams Tiny = SmallSky(3U);
	Tiny.Width = 3;
	Tiny.Height = 1;
	const Image T = MakeSkyMap(Tiny);
	CHECK(T.Width >= 64 && T.Height >= 32);
	CHECK(T.Bgra.size() == static_cast<size_t>(T.Width) * static_cast<size_t>(T.Height) * 4U);
}

static void TestSun()
{
	const Image Y1 = MakeSunMap(SmallSun(5U, 5800.0));
	const Image Y2 = MakeSunMap(SmallSun(5U, 5800.0));
	CHECK(Y1.Bgra == Y2.Bgra);
	CHECK(MakeSunMap(SmallSun(6U, 5800.0)).Bgra != Y1.Bgra);
	SunParams One = SmallSun(5U, 5800.0);
	One.Threads = 1U;
	SunParams Many = SmallSun(5U, 5800.0);
	Many.Threads = 4U;
	CHECK(MakeSunMap(One).Bgra == MakeSunMap(Many).Bgra);

	const Stats Sun = Measure(Y1);
	CHECK(Sun.AllOpaque);
	CHECK(Sun.MeanLuma > 0.12 && Sun.MeanLuma < 0.95); // a lit surface
	CHECK(Sun.MeanR > Sun.MeanB);                       // a Sun-type star leans warm
	CHECK(Sun.MeanB > 0.45 * Sun.MeanR);                // but is yellow-white, not orange

	const Stats Red = Measure(MakeSunMap(SmallSun(5U, 3200.0)));
	const Stats Blue = Measure(MakeSunMap(SmallSun(5U, 12000.0)));
	CHECK(Red.MeanR / Red.MeanB > Sun.MeanR / Sun.MeanB);
	CHECK(Sun.MeanR / Sun.MeanB > Blue.MeanR / Blue.MeanB);
	CHECK(Blue.MeanB > 0.9 * Blue.MeanR); // blue-white

	// Spots: an active star has more dark pixels than a quiet one.
	const Stats Quiet = Measure(MakeSunMap(SmallSun(5U, 5800.0, 0.0)));
	const Stats Busy = Measure(MakeSunMap(SmallSun(5U, 5800.0, 2.0)));
	CHECK(Busy.DarkShare >= Quiet.DarkShare);
	// Both ends join.
	double Seam = 0.0;
	double Inner = 0.0;
	for (int Yy = 0; Yy < Y1.Height; ++Yy)
	{
		Seam += std::fabs(Luma(Y1, 0, Yy) - Luma(Y1, Y1.Width - 1, Yy));
		Inner += std::fabs(Luma(Y1, 100, Yy) - Luma(Y1, 101, Yy));
	}
	CHECK(Seam < Inner * 2.5 + 0.5);
}

static void TestCorona()
{
	const Image C = MakeCorona(256, 7U, 5800.0);
	const Image D = MakeCorona(256, 7U, 5800.0);
	CHECK(C.Bgra == D.Bgra);
	CHECK(C.Width == 256 && C.Height == 256);
	// The middle is black (the star's own disc hides it), the edge is dark, the glow sits in between.
	CHECK(Luma(C, 128, 128) < 1e-3);
	double Edge = 0.0;
	for (int I = 0; I < 256; ++I)
	{
		Edge = std::max(Edge, std::max(std::max(Luma(C, I, 0), Luma(C, I, 255)), std::max(Luma(C, 0, I), Luma(C, 255, I))));
	}
	CHECK(Edge < 0.02);
	// Brightness falls with the radius on average.
	auto Ring = [&](double R0, double R1) {
		double Sum = 0.0;
		int N = 0;
		for (int Y = 0; Y < 256; ++Y)
		{
			for (int X = 0; X < 256; ++X)
			{
				const double U = (X + 0.5) / 128.0 - 1.0;
				const double V = (Y + 0.5) / 128.0 - 1.0;
				const double R = std::sqrt(U * U + V * V);
				if (R >= R0 && R < R1)
				{
					Sum += Luma(C, X, Y);
					++N;
				}
			}
		}
		return N != 0 ? Sum / N : 0.0;
	};
	const double Near = Ring(0.17, 0.25);
	const double Mid = Ring(0.35, 0.50);
	const double Far = Ring(0.70, 0.85);
	CHECK(Near > Mid && Mid > Far);
	CHECK(Near > 0.05);
	// Warm for a Sun-type star, bluer for a hot one.
	double Rw = 0.0;
	double Gw = 0.0;
	double Bw = 0.0;
	C.Get(128 + 40, 128, Rw, Gw, Bw);
	CHECK(Rw >= Bw);
	const Image Hot = MakeCorona(256, 7U, 14000.0);
	double Rh = 0.0;
	double Gh = 0.0;
	double Bh = 0.0;
	Hot.Get(128 + 40, 128, Rh, Gh, Bh);
	CHECK(Bh / std::max(1e-9, Rh) > Bw / std::max(1e-9, Rw));
	// Streamers: the glow differs between directions at the same radius (not a plain disc).
	double Mn = 1e9;
	double Mx = 0.0;
	for (int K = 0; K < 64; ++K)
	{
		const double T = kTwoPi * K / 64.0;
		const int X = 128 + static_cast<int>(std::lround(std::cos(T) * 70.0));
		const int Y = 128 + static_cast<int>(std::lround(std::sin(T) * 70.0));
		const double L = Luma(C, X, Y);
		Mn = std::min(Mn, L);
		Mx = std::max(Mx, L);
	}
	CHECK(Mx > Mn * 1.15);
}

int main()
{
	TestNoise();
	TestBlackbody();
	TestSky();
	TestSun();
	TestCorona();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
